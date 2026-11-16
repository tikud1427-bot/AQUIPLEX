/**
 * AQUA Storage — immutable object store seam (scalability Phase 2c)
 *
 * Binary artifact files. Backends:
 *   fs   the local disk (today's behaviour; one instance only)
 *   pg   table aqua_objects (migration 0028): shared by every instance, used
 *        with AQUA_STORE_PARTITIONS=artifacts:on and by the tests
 *   gcs  Google Cloud Storage — the production target, Phase 4. NOT IMPLEMENTED:
 *        selecting it throws, it never silently falls back.
 *
 * Contract: objects are WRITE-ONCE. put() of an existing key with the same
 * bytes succeeds (idempotent retry); with different bytes it throws — a key
 * is never overwritten. get() returns a Buffer or null. deletePrefix() removes
 * one owner's objects under a key prefix (exact prefix, no LIKE wildcards).
 */
import crypto from 'node:crypto';

import { getPool } from '../db/pool.js';

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

export function createPgObjectStore({ pool: injected = null } = {}) {
  const pool = async () => {
    const p = injected ?? (await getPool());
    if (!p) throw new Error('object store: DATABASE_URL is not configured');
    return p;
  };
  return {
    kind: 'pg',
    async put(key, buffer, { ownerId }) {
      if (!ownerId) throw new Error('object store: ownerId is required');
      const p = await pool();
      const digest = sha(buffer);
      const { rowCount } = await p.query(
        `INSERT INTO aqua_objects (object_key, owner_id, sha256, size, data) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (object_key) DO NOTHING`, [key, String(ownerId), digest, buffer.length, buffer]);
      if (rowCount) return { created: true, sha256: digest };
      const { rows } = await p.query('SELECT sha256, owner_id FROM aqua_objects WHERE object_key = $1', [key]);
      if (rows[0]?.sha256 === digest && rows[0]?.owner_id === String(ownerId)) return { created: false, sha256: digest };
      throw new Error(`object store: ${key} already exists with different content or owner — objects are write-once`);
    },
    async get(key, { ownerId = null } = {}) {
      const p = await pool();
      const { rows } = await p.query(
        `SELECT data, owner_id FROM aqua_objects WHERE object_key = $1`, [key]);
      if (!rows.length) return null;
      if (ownerId != null && rows[0].owner_id !== String(ownerId)) throw new Error(`object store: ${key} belongs to a different owner`);
      return rows[0].data;
    },
    /** Same interface as the GCS backend: a readable stream, or null. */
    async getStream(key, opts = {}) {
      const buf = await this.get(key, opts);
      if (!buf) return null;
      const { Readable } = await import('node:stream');
      return { stream: Readable.from([buf]), size: buf.length, sha256: sha(buf) };
    },
    async deletePrefix(ownerId, prefix) {
      const p = await pool();
      const { rowCount } = await p.query(
        `DELETE FROM aqua_objects WHERE owner_id = $1 AND left(object_key, length($2)) = $2`, [String(ownerId), prefix]);
      return rowCount ?? 0;
    },
  };
}

/**
 * Google Cloud Storage backend (scalability Phase 4B) — the JSON API over an
 * injectable `transport` (fetch-compatible) and `token` provider, so tests run
 * against a local emulator or an in-process fake, never a real bucket.
 *
 *   object name   the key itself (artifacts/<id>/<versionDir>/<path>)
 *   metadata      owner (the owning account) and sha256 (of the bytes)
 *   write-once    an existing object with the same sha256 and owner = an
 *                 idempotent retry (created: false); different = refused. The
 *                 upload itself carries ifGenerationMatch=0, so on real GCS two
 *                 writers racing for one new key cannot both succeed (412 → the
 *                 same comparison). Keys are unique per version, so a race only
 *                 happens between retries of the same bytes.
 *   interrupted   a GCS upload is atomic: an interrupted upload leaves no object,
 *   uploads       and the retry starts over (same key, same bytes → created).
 *   owner check   get/stream read the object's owner metadata first; another
 *                 owner's object is refused (and a missing object is null).
 *   auth          the Cloud Run service account's token from the metadata
 *                 server (cached until shortly before expiry). With an explicit
 *                 endpoint (an emulator) and no token provider: unauthenticated.
 */
export function createGcsObjectStore({
  bucket, endpoint = 'https://storage.googleapis.com', transport = globalThis.fetch,
  token = null, retries = 3,
} = {}) {
  if (!bucket) throw new Error('object store (gcs): a bucket name is required (AQUA_GCS_BUCKET)');
  const base = endpoint.replace(/\/$/, '');
  const o = key => `${base}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`;
  const getToken = token ?? (endpoint === 'https://storage.googleapis.com' ? metadataServerToken(transport) : async () => null);

  async function call(url, init = {}, { okStatuses = [] } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const t = await getToken();
      const headers = { ...(init.headers ?? {}), ...(t ? { Authorization: `Bearer ${t}` } : {}) };
      let res;
      try { res = await transport(url, { ...init, headers }); }
      catch (err) { lastErr = err; await backoff(attempt); continue; }        // network: retry (uploads are atomic)
      if (res.ok || okStatuses.includes(res.status)) return res;
      if (res.status === 429 || res.status >= 500) { lastErr = new Error(`gcs ${res.status}`); await backoff(attempt); continue; }
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error(`object store (gcs): HTTP ${res.status} ${text.slice(0, 200)}`), { status: res.status });
    }
    throw lastErr ?? new Error('object store (gcs): request failed');
  }

  async function meta(key) {
    const res = await call(o(key), { method: 'GET' }, { okStatuses: [404] });
    if (res.status === 404) return null;
    return res.json();
  }

  function assertOwner(m, key, ownerId) {
    if (ownerId != null && (m?.metadata?.owner ?? null) !== String(ownerId)) {
      throw new Error(`object store: ${key} belongs to a different owner`);
    }
  }

  return {
    kind: 'gcs',
    async put(key, buffer, { ownerId, contentType = 'application/octet-stream' }) {
      if (!ownerId) throw new Error('object store: ownerId is required');
      const digest = sha(buffer);
      const existing = await meta(key);
      if (existing) {
        if (existing.metadata?.sha256 === digest && existing.metadata?.owner === String(ownerId)) return { created: false, sha256: digest };
        throw new Error(`object store: ${key} already exists with different content or owner — objects are write-once`);
      }
      const boundary = `aqua-${crypto.randomBytes(8).toString('hex')}`;
      const head = JSON.stringify({ name: key, contentType, metadata: { owner: String(ownerId), sha256: digest } });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${head}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
        buffer, Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const res = await call(`${base}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=multipart&ifGenerationMatch=0`,
        { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }, { okStatuses: [412] });
      if (res.status === 412) {
        // Another writer created it first (real GCS): the same comparison as above.
        const now = await meta(key);
        if (now?.metadata?.sha256 === digest && now?.metadata?.owner === String(ownerId)) return { created: false, sha256: digest };
        throw new Error(`object store: ${key} already exists with different content or owner — objects are write-once`);
      }
      return { created: true, sha256: digest };
    },
    async get(key, { ownerId = null } = {}) {
      const m = await meta(key);
      if (!m) return null;
      assertOwner(m, key, ownerId);
      const res = await call(`${o(key)}?alt=media`, { method: 'GET' }, { okStatuses: [404] });
      if (res.status === 404) return null;                                   // deleted between the two calls
      return Buffer.from(await res.arrayBuffer());
    },
    /** A readable stream of the object (no local copy), or null. Owner-checked. */
    async getStream(key, { ownerId = null } = {}) {
      const m = await meta(key);
      if (!m) return null;
      assertOwner(m, key, ownerId);
      const res = await call(`${o(key)}?alt=media`, { method: 'GET' }, { okStatuses: [404] });
      if (res.status === 404) return null;
      const { Readable } = await import('node:stream');
      return { stream: Readable.fromWeb(res.body), size: Number(m.size ?? 0), sha256: m.metadata?.sha256 ?? null };
    },
    async deletePrefix(ownerId, prefix) {
      let n = 0; let pageToken = null;
      do {
        const url = `${base}/storage/v1/b/${encodeURIComponent(bucket)}/o?prefix=${encodeURIComponent(prefix)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const page = await (await call(url, { method: 'GET' })).json();
        for (const item of page.items ?? []) {
          if (!item.name.startsWith(prefix)) continue;                          // exact prefix, never a pattern
          if ((item.metadata?.owner ?? null) !== String(ownerId)) continue;     // never another owner's object
          await call(o(item.name), { method: 'DELETE' }, { okStatuses: [404] });
          n++;
        }
        pageToken = page.nextPageToken ?? null;
      } while (pageToken);
      return n;
    },
  };
}

const backoff = attempt => new Promise(r => setTimeout(r, Math.min(2_000, 100 * 2 ** attempt)).unref?.());

/** Cloud Run / GCE: the service account's access token, cached until 60 s before expiry. */
function metadataServerToken(transport) {
  let cached = null;
  return async () => {
    if (cached && cached.until > Date.now()) return cached.token;
    const res = await transport('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } });
    if (!res.ok) throw new Error(`object store (gcs): metadata server token HTTP ${res.status}`);
    const j = await res.json();
    cached = { token: j.access_token, until: Date.now() + Math.max(0, (j.expires_in ?? 300) - 60) * 1000 };
    return cached.token;
  };
}

/** The backend AQUA_OBJECT_STORE names (default pg when artifacts are on partitions). */
export function objectStoreFromEnv(env = process.env) {
  const kind = String(env.AQUA_OBJECT_STORE ?? 'pg').toLowerCase();
  if (kind === 'pg') return createPgObjectStore();
  if (kind === 'gcs') {
    return createGcsObjectStore({
      bucket: env.AQUA_GCS_BUCKET,
      ...(env.AQUA_GCS_ENDPOINT ? { endpoint: env.AQUA_GCS_ENDPOINT } : {}),
    });
  }
  throw new Error(`AQUA_OBJECT_STORE=${kind} is not a known backend (pg | gcs)`);
}
