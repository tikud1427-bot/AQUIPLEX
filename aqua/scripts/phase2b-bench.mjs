#!/usr/bin/env node
/**
 * Phase 2b — what a request pays with stores on owner partitions.
 *
 *   node scripts/phase2b-bench.mjs --db <local test url> [--convs 50] [--msgs 40] [--others 2000]
 *
 * Seeds one heavy owner (convs × msgs messages, a Mind, reflection state) among
 * `--others` other owners, then measures, IN ONE PROCESS with
 * AQUA_STORE_PARTITIONS=history:on,mind:on,reflection:on:
 *   cold load      first ensureOwnerLoaded for the heavy owner
 *   warm load      the same with nothing changed (versions-only query)
 *   after change   one message added by "another instance", then reload
 *   append         addMessage + flush, per message (bytes written by partitions)
 * and, for comparison, the bytes the whole-file path writes for one message.
 *
 * SAFETY: --db only (never .env), local hosts only, its own temp data dir, and it
 * deletes the rows it wrote. Never connects to Mongo (MONGO_URI blanked).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const DB = arg('--db', null);
if (!DB) { console.error('✗ --db is required'); process.exit(2); }
if (!['localhost', '127.0.0.1', '::1'].includes(new URL(DB).hostname)) { console.error('✗ local databases only'); process.exit(2); }
const CONVS = Number(arg('--convs', '50')); const MSGS = Number(arg('--msgs', '40')); const OTHERS = Number(arg('--others', '2000'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-bench-'));
Object.assign(process.env, {
  DATABASE_URL: DB, AQUA_DATA_DIR: dir, MONGO_URI: '', AQUA_DISABLE_MONGO_MIRROR: '1',
  AQUA_STORE_PARTITIONS: 'history:on,mind:on,reflection:on',
});
const pg = (await import('pg')).default;
const admin = new pg.Pool({ connectionString: DB, max: 2 });
await (await import('../src/core/db/migrate.js')).migrate();
const KEYS = ['.aqua-history.json', '.aqua-mind.json', '.aqua-reflection.json'];
await admin.query('DELETE FROM aqua_store_partitions WHERE store_key = ANY($1)', [KEYS]);

// Seed through the migration path (what an operator does), from a realistic file.
const { migrateStoreText } = await import('../src/core/storage/partitionMigration.js');
const HEAVY = '4242';
const convs = {};
for (let c = 0; c < CONVS; c++) convs[`heavy-${c}`] = { messages: Array.from({ length: MSGS }, (_, k) => ({ role: k % 2 ? 'assistant' : 'user', content: `message ${k} ${'lorem ipsum '.repeat(20)}`, ts: 1_700_000_000_000 + k })), meta: { userId: HEAVY, title: `Conversation ${c}` } };
for (let o = 0; o < OTHERS; o++) convs[`other-${o}`] = { messages: [{ role: 'user', content: 'hi', ts: 1 }], meta: { userId: `o${o}` } };
const historyText = JSON.stringify({ __aqua: { schema: 1, savedAt: 1 }, data: convs });
const mindText = JSON.stringify({ __aqua: { schema: 1, savedAt: 1 }, data: { [`user:${HEAVY}`]: { version: 2, ownerId: `user:${HEAVY}`, updatedAt: 1, facts: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`f${i}`, { key: `f${i}`, value: `v${i}`, ts: i }])), files: {}, beliefs: {}, goals: {}, episodes: {} } } });
const reflText = JSON.stringify({ __aqua: { schema: 1, savedAt: 1 }, data: { [`user:${HEAVY}`]: { snapshot: null, lastReflectionAt: 0, lastSurfacedAt: 0 } } });
for (const [k, t] of [[KEYS[0], historyText], [KEYS[1], mindText], [KEYS[2], reflText]]) await migrateStoreText({ storeKey: k, text: t, mode: 'apply', pool: admin });

const conv = await import('../src/memory/conversationStore.js');
await import('../src/mind/mindStore.js');
await import('../src/brain/reflectionV2/reflectionStore.js');
const binding = await import('../src/core/storage/ownerBinding.js');
await binding.configureOwnerBindings();

const ms = async fn => { const t = performance.now(); const r = await fn(); return [performance.now() - t, r]; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(2); };
const owner = `user:${HEAVY}`;

const [cold, coldR] = await ms(() => binding.ensureOwnerLoaded(owner));
const warm = [];
for (let i = 0; i < 20; i++) warm.push((await ms(() => binding.ensureOwnerLoaded(owner)))[0]);

// Another instance appends one message (direct row insert, as its flush would).
await admin.query(`INSERT INTO aqua_store_partitions (store_key, partition_key, owner_id, data, bytes, checksum, version)
  VALUES ('.aqua-history.json', 'm:heavy-0:1-zzzzzzzzz-0000-00000000', $1, '{"role":"user","content":"from B","ts":9}', 40, 'x', 1)`, [owner]);
const [changed, changedR] = await ms(() => binding.ensureOwnerLoaded(owner));

const repoStats = () => binding.partitionRepositoryForBindings().stats();
const appends = []; const before = repoStats().bytesWritten;
for (let i = 0; i < 50; i++) {
  appends.push((await ms(async () => { conv.addMessage('heavy-1', 'user', `new message ${i} ${'x'.repeat(200)}`); await binding.flushOwnerBindings(); }))[0]);
}
const bytesPerAppend = (repoStats().bytesWritten - before) / 50;

const out = {
  at: new Date().toISOString(), node: process.version,
  pg: (await admin.query('SHOW server_version')).rows[0].server_version,
  heavyOwner: { conversations: CONVS, messages: CONVS * MSGS, mindFacts: 200 }, otherOwners: OTHERS,
  coldLoadMs: +cold.toFixed(2), coldRowsFetched: coldR.fetched,
  warmLoadMs: { p50: pct(warm, 50), p95: pct(warm, 95), max: pct(warm, 100) },
  afterOneRemoteChangeMs: +changed.toFixed(2), rowsFetchedAfterChange: changedR.fetched,
  appendPlusFlushMs: { p50: pct(appends, 50), p95: pct(appends, 95), max: pct(appends, 100) },
  bytesWrittenPerAppend: Math.round(bytesPerAppend),
  wholeFileBytesPerAppendToday: Buffer.byteLength(historyText),
  messagesVisibleAfterRemoteChange: conv.getConversation('heavy-0').length,
  processRssMb: +(process.memoryUsage().rss / 1048576).toFixed(1),
};
console.log(JSON.stringify(out, null, 2));
const outFile = arg('--out', null);
if (outFile) fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
await admin.query('DELETE FROM aqua_store_partitions WHERE store_key = ANY($1)', [KEYS]);
await admin.end();
await (await import('../src/core/db/pool.js')).closePool();
process.exit(0);
