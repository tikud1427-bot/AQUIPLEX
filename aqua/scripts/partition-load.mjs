#!/usr/bin/env node
/**
 * Owner-partitioned storage — multi-process load and write-shape measurement
 * (scalability Phase 2a; reused by Phase 6).
 *
 *   node scripts/partition-load.mjs --db <url> [--procs 8] [--ops 250] [--owners 1000] [--hot 0.1]
 *   node scripts/partition-load.mjs --db <url> --shape [--owner-counts 100,1000,5000] [--samples 20]
 *
 * CONTENTION MODE spawns N separate OS processes, each with its own pg Pool and
 * its own repository cache: N application instances. Every process does
 * read-modify-write increments, a `--hot` fraction of them on ONE shared
 * partition, the rest on random owners. Each op appends its unique id to the
 * partition, so the parent can count:
 *   lost updates   = ops acknowledged − ids present
 *   duplicates     = ids present more than once
 * and reports p50/p95/p99 latency, throughput, conflicts/retries, peak
 * connections (pg_stat_activity) and RSS per process.
 *
 * SHAPE MODE compares one owner's update under both substrates on the same
 * server: the E3 blob (whole store rewritten) and a partition row.
 *
 * SAFETY: refuses any database that is not given explicitly with --db, and any
 * non-local host unless --allow-remote. Writes only store keys `.load-<run>-*`
 * and the blob key `.load-<run>-blob.json`, and deletes them afterwards. Never
 * loads .env. Never imports core/dataDir.js (Mongo hydration at import).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const has = name => process.argv.includes(name);

const DB = arg('--db', null);
if (!DB) { console.error('✗ --db <postgres url> is required (never taken from the environment)'); process.exit(2); }
const host = new URL(DB).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(host) && !has('--allow-remote')) {
  console.error(`✗ refusing non-local database host ${host} without --allow-remote`); process.exit(2);
}
process.env.DATABASE_URL = DB;   // the repository's default pool is never used; set for migrate()

const { default: pg } = await import('pg');
const { createPartitionRepository, TABLE } = await import('../src/core/storage/partitionRepository.js');

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
const summary = arr => {
  const s = [...arr].sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s.at(-1) ?? null,
    mean: s.length ? +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2) : null };
};
const round = v => (v == null ? v : +v.toFixed(2));

// ── child: one "instance" ───────────────────────────────────────────────────
if (has('--child')) {
  const storeKey = arg('--store');
  const ops = Number(arg('--ops', '250'));
  const owners = Number(arg('--owners', '1000'));
  const hot = Number(arg('--hot', '0.1'));
  const id = arg('--id');
  const pool = new pg.Pool({ connectionString: DB, max: Number(arg('--pool-max', '2')) });
  const repo = createPartitionRepository({ pool, instanceId: `load-${id}` });
  const lat = [];
  let errors = 0; let done = 0;
  const firstError = [];
  for (let i = 0; i < ops; i++) {
    const owner = Math.random() < hot ? 'user:hot' : `user:${Math.floor(Math.random() * owners)}`;
    const opId = `${id}.${i}`;
    const t0 = performance.now();
    try {
      await repo.update(storeKey, `o:${owner}`, text => {
        const v = text ? JSON.parse(text) : { n: 0, ops: [] };
        v.n += 1; v.ops.push(opId);
        return JSON.stringify(v);
      }, { ownerId: owner, maxAttempts: 500 });
      done++;
      lat.push(performance.now() - t0);
    } catch (err) {
      errors++;
      if (firstError.length < 3) firstError.push(`${err.name}: ${err.message}`);
    }
  }
  const st = repo.stats();
  process.stdout.write(JSON.stringify({ id, done, errors, firstError, lat, conflicts: st.conflicts, retries: st.retries,
    rssMb: +(process.memoryUsage().rss / 1048576).toFixed(1) }));
  await pool.end();
  process.exit(0);
}

// ── parent ──────────────────────────────────────────────────────────────────
const RUN = crypto.randomBytes(4).toString('hex');
const admin = new pg.Pool({ connectionString: DB, max: 3 });
await (await import('../src/core/db/migrate.js')).migrate();
const { closePool } = await import('../src/core/db/pool.js');
const dbName = new URL(DB).pathname.slice(1);
const out = { at: new Date().toISOString(), run: RUN, node: process.version, platform: process.platform,
  pg: (await admin.query('SHOW server_version')).rows[0].server_version, host };

async function cleanup() {
  await admin.query(`DELETE FROM ${TABLE} WHERE store_key LIKE $1`, [`.load-${RUN}-%`]);
  await admin.query('DELETE FROM aqua_store_blobs WHERE store_key LIKE $1', [`.load-${RUN}-%`]);
}

async function contention() {
  const procs = Number(arg('--procs', '8'));
  const ops = Number(arg('--ops', '250'));
  const owners = Number(arg('--owners', '1000'));
  const hot = Number(arg('--hot', '0.1'));
  const storeKey = `.load-${RUN}-contention.json`;
  const script = fileURLToPath(import.meta.url);

  let peakConns = 0;
  const sampler = setInterval(async () => {
    try {
      const { rows } = await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [dbName]);
      peakConns = Math.max(peakConns, rows[0].n);
    } catch { /* sampling only */ }
  }, 100);

  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: procs }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--child', '--db', DB, '--store', storeKey, '--ops', String(ops),
      '--owners', String(owners), '--hot', String(hot), '--id', `p${i}`, ...(has('--allow-remote') ? ['--allow-remote'] : [])],
    { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    child.stdout.on('data', d => { buf += d; });
    child.on('exit', code => (code === 0 ? resolve(JSON.parse(buf)) : reject(new Error(`child p${i} exit ${code}`))));
  })));
  const wallMs = performance.now() - t0;
  clearInterval(sampler);

  // Verify: every acknowledged op is present exactly once.
  const { rows } = await admin.query(`SELECT data FROM ${TABLE} WHERE store_key = $1 AND deleted_at IS NULL`, [storeKey]);
  const seen = new Map();
  let counterSum = 0;
  for (const r of rows) {
    const v = JSON.parse(r.data);
    counterSum += v.n;
    for (const id of v.ops) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  const acknowledged = results.reduce((n, r) => n + r.done, 0);
  const duplicates = [...seen.values()].filter(c => c > 1).length;
  const lat = results.flatMap(r => r.lat);
  const hotRow = await admin.query(`SELECT data, version FROM ${TABLE} WHERE store_key = $1 AND partition_key = 'o:user:hot'`, [storeKey]);

  out.contention = {
    params: { procs, opsPerProc: ops, owners, hotFraction: hot, poolMaxPerProc: Number(arg('--pool-max', '2')) },
    acknowledged, errors: results.reduce((n, r) => n + r.errors, 0), firstErrors: results.flatMap(r => r.firstError).slice(0, 3),
    idsPresent: seen.size, counterSum,
    lostUpdates: acknowledged - seen.size, duplicates,
    counterMatchesIds: counterSum === seen.size,
    hotPartition: hotRow.rows[0] ? { n: JSON.parse(hotRow.rows[0].data).n, version: Number(hotRow.rows[0].version) } : null,
    conflicts: results.reduce((n, r) => n + r.conflicts, 0), retries: results.reduce((n, r) => n + r.retries, 0),
    throughputOpsPerSec: round(acknowledged / (wallMs / 1000)), wallMs: round(wallMs),
    latencyMs: Object.fromEntries(Object.entries(summary(lat)).map(([k, v]) => [k, round(v)])),
    peakConnections: peakConns,
    rssMbPerProc: summary(results.map(r => r.rssMb)),
  };
}

async function shape() {
  const counts = String(arg('--owner-counts', '100,1000,5000')).split(',').map(Number);
  const samples = Number(arg('--samples', '20'));
  const pool = new pg.Pool({ connectionString: DB, max: 2 });
  const repo = createPartitionRepository({ pool, instanceId: 'shape' });
  const ownerValue = i => ({ version: 2, facts: { name: { value: `Owner ${i}`, ts: i }, city: { value: 'Somewhere', ts: i } },
    beliefs: { b1: { text: 'x'.repeat(600) } } });   // ~1 KB per owner, the E3 measurement's order of magnitude
  out.shape = [];
  for (const owners of counts) {
    const blobKey = `.load-${RUN}-blob-${owners}.json`;
    const partKey = `.load-${RUN}-part-${owners}.json`;
    const all = Object.fromEntries(Array.from({ length: owners }, (_, i) => [`user:${i}`, ownerValue(i)]));
    let text = JSON.stringify({ __aqua: { schema: 1, savedAt: Date.now() }, data: all });
    await admin.query('INSERT INTO aqua_store_blobs (store_key, data, bytes, checksum, version) VALUES ($1,$2,$3,$4,1)',
      [blobKey, text, Buffer.byteLength(text), 'x']);
    // Seed the same owners as partition rows, 1,000 per INSERT.
    const rowsToSeed = Object.entries(all).map(([o, v], i) => [partKey, `o:${o}`, o, i, JSON.stringify(v)]);
    for (let i = 0; i < rowsToSeed.length; i += 1000) {
      const chunk = rowsToSeed.slice(i, i + 1000);
      const placeholders = chunk.map((_, j) => { const b = j * 5; return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},0,'x',1)`; });
      await admin.query(`INSERT INTO ${TABLE} (store_key,partition_key,owner_id,ordinal,data,bytes,checksum,version) VALUES ${placeholders.join(',')}`,
        chunk.flat());
    }

    const blobMs = []; const partMs = []; let blobBytes = 0; let partBytes = 0; let version = 1;
    for (let s = 0; s < samples; s++) {
      const who = `user:${Math.floor(Math.random() * owners)}`;
      // Blob: what a flush does today: serialise every owner, rewrite one row (version-guarded).
      let t = performance.now();
      all[who].facts.city = { value: `City ${s}`, ts: Date.now() };
      text = JSON.stringify({ __aqua: { schema: 1, savedAt: Date.now() }, data: all });
      const r = await admin.query(
        `UPDATE aqua_store_blobs SET data=$2, bytes=$3, version=version+1, updated_at=now() WHERE store_key=$1 AND version=$4 RETURNING version`,
        [blobKey, text, Buffer.byteLength(text), version]);
      version = r.rows[0].version;
      blobMs.push(performance.now() - t);
      blobBytes = Buffer.byteLength(text);
      // Partition: read-modify-write of that owner's row only.
      t = performance.now();
      const before = repo.stats().bytesWritten;
      await repo.update(partKey, `o:${who}`, cur => {
        const v = JSON.parse(cur); v.facts.city = { value: `City ${s}`, ts: Date.now() }; return JSON.stringify(v);
      }, { ownerId: who });
      partMs.push(performance.now() - t);
      partBytes = repo.stats().bytesWritten - before;
    }
    const b = summary(blobMs); const p = summary(partMs);
    out.shape.push({ owners, samples,
      blob: { bytesPerWrite: blobBytes, p50Ms: round(b.p50), p95Ms: round(b.p95) },
      partition: { bytesPerWrite: partBytes, p50Ms: round(p.p50), p95Ms: round(p.p95) },
      bytesRatio: round(blobBytes / partBytes) });
  }
  await pool.end();
}

try {
  if (has('--shape')) await shape(); else await contention();
} finally {
  await cleanup();
  await admin.end();
  await closePool();
}
const json = JSON.stringify(out, null, 2);
console.log(json);
const outFile = arg('--out', null);
if (outFile) fs.writeFileSync(outFile, json);
