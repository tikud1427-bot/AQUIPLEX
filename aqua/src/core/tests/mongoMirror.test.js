/**
 * Mongo Mirror — deploy-survival + hardening tests (P0)
 *
 * A file-backed fake collection stands in for the Mongo cluster (mongod
 * binaries can't run in CI); DATA_DIR plays the ephemeral Render disk.
 * The REAL code paths are exercised end to end: store mutation → debounced
 * flush → SIGTERM shutdown hook → mirrorWrite/drain → disk wipe → dataDir's
 * top-level hydration → store reload.
 *
 *   1. lifecycle    — conversation + attachment + memory survive a deploy
 *   2. newer-wins   — a warm instance's local files are never clobbered
 *   3. chunking     — a store far over the chunk size round-trips intact
 *   4. heartbeat    — a second live writer raises the multi-writer alarm
 *                     (with deploy-overlap grace)
 *
 * Run: node --test src/core/tests/mongoMirror.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const CONV_ID = 'deploy-survival-conv';
const OWNER   = 'user:deploy-survival';

// ── Shared child preamble: file-backed fake Mongo collection ─────────────────
// One JSON file = the "cluster". Supports the exact driver surface the mirror
// uses: find({}).toArray(), findOne, updateOne($set, upsert), deleteMany.
const FAKE_COLLECTION_SRC = `
import fs from 'node:fs';
const DB = process.env.FAKE_DB;
function readAll() { try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return {}; } }
function writeAll(a) { fs.writeFileSync(DB, JSON.stringify(a)); }
function matches(doc, q = {}) {
  for (const [k, v] of Object.entries(q)) {
    if (v && typeof v === 'object' && '$lt' in v) { if (!(doc[k] < v.$lt)) return false; }
    else if (doc[k] !== v) return false;
  }
  return true;
}
export const fakeCollection = {
  find(q = {}) { return { async toArray() { return Object.values(readAll()).filter(d => matches(d, q)); } }; },
  async findOne(q = {}) { return Object.values(readAll()).find(d => matches(d, q)) ?? null; },
  async updateOne(filter, update) {
    const all = readAll();
    all[filter._id] = { _id: filter._id, ...(all[filter._id] ?? {}), ...update.$set };
    writeAll(all);
  },
  async deleteMany(q = {}) {
    const all = readAll();
    for (const [id, d] of Object.entries(all)) if (matches(d, q)) delete all[id];
    writeAll(all);
  },
};
`;

function runChild(name, body, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-child-'));
  const fake = path.join(dir, 'fake.mjs');
  const main = path.join(dir, 'main.mjs');
  fs.writeFileSync(fake, FAKE_COLLECTION_SRC);
  fs.writeFileSync(main, `
import { fakeCollection } from ${JSON.stringify(fake)};
import { __setCollectionForTests } from ${JSON.stringify(path.join(AQUA_ROOT, 'src/core/mongoMirror.js'))};
__setCollectionForTests(fakeCollection);   // BEFORE any store import — hydration must see it
${body}
`);
  const res = spawnSync(process.execPath, [main], {
    cwd: AQUA_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (res.status !== env.__EXPECT_STATUS) {
    console.error(`--- ${name} stdout ---\n${res.stdout}\n--- ${name} stderr ---\n${res.stderr}`);
  }
  return res;
}

test('conversation + attachment + memory survive a simulated Render deploy', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-life-'));
  const FAKE_DB  = path.join(scratch, 'mongo.json');
  const DATA_1   = path.join(scratch, 'container-1');
  const DATA_2   = path.join(scratch, 'container-2');

  // ── BOOT 1: old container writes data, then gets the deploy SIGTERM ──
  const boot1 = runChild('boot1', `
const { getOrCreateConversation, addMessage, getConversation } =
  await import(${JSON.stringify(path.join(AQUA_ROOT, 'src/memory/conversationStore.js'))});
const { attachToConversation } =
  await import(${JSON.stringify(path.join(AQUA_ROOT, 'src/upload/attachmentStore.js'))});
const { storeFact } =
  await import(${JSON.stringify(path.join(AQUA_ROOT, 'src/memory/longTermMemory.js'))});

getOrCreateConversation(${JSON.stringify(CONV_ID)}, { userId: 'u-test', title: 'Deploy survival' });
addMessage(${JSON.stringify(CONV_ID)}, 'user', 'What is in the invoice PDF?');
addMessage(${JSON.stringify(CONV_ID)}, 'assistant', 'The invoice total is Rs 92,000.');

attachToConversation(${JSON.stringify(CONV_ID)}, {
  name: 'invoice.pdf', kind: 'document',
  normalized: { format: 'pdf', title: 'Invoice 4471', content: 'INVOICE #4471 total Rs 92,000',
                metadata: { pages: 1 }, sections: [], pages: 1, language: 'en', truncated: false },
});

storeFact(${JSON.stringify(OWNER)}, { key: 'company', value: 'Aquiplex', category: 'work', confidence: 0.9, sourceMessage: 'test' });

if (getConversation(${JSON.stringify(CONV_ID)}).length !== 2) { console.error('precondition failed'); process.exit(1); }
console.log('BOOT1_WROTE');
process.kill(process.pid, 'SIGTERM');   // the deploy — real shutdown path: flush → mirror → drain
setTimeout(() => { console.error('SIGTERM hook never exited'); process.exit(1); }, 10_000);
`, { AQUA_DATA_DIR: DATA_1, FAKE_DB, __EXPECT_STATUS: 143 });

  assert.equal(boot1.status, 143, 'boot 1 must exit via the SIGTERM shutdown path (code 143)');
  assert.match(boot1.stdout, /BOOT1_WROTE/);

  // The "cluster" must now hold the mirrored stores.
  const mirrored = JSON.parse(fs.readFileSync(FAKE_DB, 'utf8'));
  assert.ok(mirrored['.aqua-history.json'],     'conversations mirrored to Mongo');
  assert.ok(mirrored['.aqua-attachments.json'], 'attachments mirrored to Mongo');
  assert.ok(mirrored['.aqua-mind.json'],        'memory (mind/facts) mirrored to Mongo');
  assert.match(mirrored['.aqua-history.json'].json, /Rs 92,000/, 'message content reached the mirror');

  // ── DEPLOY: Render rebuilds the container — the disk is GONE ──
  fs.rmSync(DATA_1, { recursive: true, force: true });

  // ── BOOT 2: new container, empty disk — hydration must restore everything ──
  const boot2 = runChild('boot2', `
const { getConversation, getConversationMeta } =
  await import(${JSON.stringify(path.join(AQUA_ROOT, 'src/memory/conversationStore.js'))});
const { getAttachments } =
  await import(${JSON.stringify(path.join(AQUA_ROOT, 'src/upload/attachmentStore.js'))});
const { getFact } =
  await import(${JSON.stringify(path.join(AQUA_ROOT, 'src/memory/longTermMemory.js'))});

const msgs = getConversation(${JSON.stringify(CONV_ID)});
const meta = getConversationMeta(${JSON.stringify(CONV_ID)});
const atts = getAttachments(${JSON.stringify(CONV_ID)});
const fact = getFact(${JSON.stringify(OWNER)}, 'company');

const ok =
  msgs.length === 2 &&
  msgs[1].content.includes('Rs 92,000') &&
  meta?.title === 'Deploy survival' &&
  meta?.userId === 'u-test' &&
  atts.length === 1 &&
  atts[0].name === 'invoice.pdf' &&
  atts[0].content.includes('92,000') &&
  fact?.value === 'Aquiplex';

console.log(ok ? 'BOOT2_RESTORED' : 'BOOT2_MISSING ' + JSON.stringify({ msgs: msgs.length, meta, atts: atts.length, fact }));
process.exit(ok ? 0 : 1);
`, { AQUA_DATA_DIR: DATA_2, FAKE_DB, __EXPECT_STATUS: 0 });

  assert.equal(boot2.status, 0, 'boot 2 must restore all data from the mirror');
  assert.match(boot2.stdout, /BOOT2_RESTORED/, 'conversation, sidebar meta, attachment, and fact all survived the deploy');
});

test('local file newer than mirror is kept (warm restart, no data loss)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-keep-'));
  const FAKE_DB = path.join(scratch, 'mongo.json');
  const DATA    = path.join(scratch, 'warm');
  fs.mkdirSync(DATA, { recursive: true });

  // Mirror holds a STALE copy (updatedAt in the past)…
  fs.writeFileSync(FAKE_DB, JSON.stringify({
    '.aqua-history.json': { _id: '.aqua-history.json', updatedAt: 1000,
      json: JSON.stringify({ __aqua: { schema: 1 }, data: { stale: { messages: [], meta: {} } } }) },
  }));
  // …while the warm instance's disk has the CURRENT copy.
  fs.writeFileSync(path.join(DATA, '.aqua-history.json'),
    JSON.stringify({ __aqua: { schema: 1 }, data: { fresh: { messages: [{ role: 'user', content: 'hi', ts: 1 }], meta: {} } } }));

  const res = runChild('warm', `
const { conversationExists } =
  await import(${JSON.stringify(path.join(AQUA_ROOT, 'src/memory/conversationStore.js'))});
const ok = conversationExists('fresh') && !conversationExists('stale');
console.log(ok ? 'KEPT_LOCAL' : 'CLOBBERED');
process.exit(ok ? 0 : 1);
`, { AQUA_DATA_DIR: DATA, FAKE_DB, __EXPECT_STATUS: 0 });

  assert.equal(res.status, 0);
  assert.match(res.stdout, /KEPT_LOCAL/, 'newer-wins: hydration must not clobber a warm instance');
});

test('a store far over the chunk size round-trips through the mirror intact', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-chunk-'));
  const FAKE_DB = path.join(scratch, 'mongo.json');
  const DATA_1  = path.join(scratch, 'container-1');
  const DATA_2  = path.join(scratch, 'container-2');
  const CHUNK   = '65536'; // 64 KB chunks → a ~400 KB store must split into many parts

  const boot1 = runChild('chunk-boot1', `
const { getOrCreateConversation, addMessage } =
  await import(${JSON.stringify(path.join(AQUA_ROOT, 'src/memory/conversationStore.js'))});
const big = 'AQUA-'.repeat(80_000) + 'END-OF-BIG-PAYLOAD'; // ~400 KB, unique tail proves byte-exactness
getOrCreateConversation('big-conv', { userId: 'u-test' });
addMessage('big-conv', 'user', big);
console.log('CHUNK_WROTE ' + big.length);
process.kill(process.pid, 'SIGTERM');
setTimeout(() => process.exit(1), 10_000);
`, { AQUA_DATA_DIR: DATA_1, FAKE_DB, AQUA_MIRROR_CHUNK_BYTES: CHUNK, __EXPECT_STATUS: 143 });

  assert.equal(boot1.status, 143);
  const db = JSON.parse(fs.readFileSync(FAKE_DB, 'utf8'));
  const manifest = db['.aqua-history.json'];
  assert.equal(manifest.chunked, true, 'oversize store must take the chunked path');
  assert.ok(manifest.parts > 5, `expected many parts, got ${manifest.parts}`);
  const partDocs = Object.values(db).filter(d => d.part && d.of === '.aqua-history.json' && d.gen === manifest.gen);
  assert.equal(partDocs.length, manifest.parts, 'every part of the manifest generation is present');

  fs.rmSync(DATA_1, { recursive: true, force: true }); // the deploy

  const boot2 = runChild('chunk-boot2', `
const { getConversation } =
  await import(${JSON.stringify(path.join(AQUA_ROOT, 'src/memory/conversationStore.js'))});
const msgs = getConversation('big-conv');
const ok = msgs.length === 1 && msgs[0].content.length === ${400_000 + 18} && msgs[0].content.endsWith('END-OF-BIG-PAYLOAD');
console.log(ok ? 'CHUNK_RESTORED' : 'CHUNK_BROKEN len=' + (msgs[0]?.content?.length ?? 'none'));
process.exit(ok ? 0 : 1);
`, { AQUA_DATA_DIR: DATA_2, FAKE_DB, AQUA_MIRROR_CHUNK_BYTES: CHUNK, __EXPECT_STATUS: 0 });

  assert.equal(boot2.status, 0);
  assert.match(boot2.stdout, /CHUNK_RESTORED/, 'chunked store reassembled byte-exact after the deploy');
});

test('heartbeat: a second live writer raises the multi-writer alarm — with deploy-overlap grace', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-beat-'));
  const FAKE_DB = path.join(scratch, 'mongo.json');
  fs.writeFileSync(FAKE_DB, '{}');
  process.env.FAKE_DB = FAKE_DB;

  const { fakeCollection } = await import(
    'data:text/javascript;base64,' + Buffer.from(FAKE_COLLECTION_SRC).toString('base64'));
  const { __setCollectionForTests, __heartbeatOnceForTests, getMirrorStatus, __resetForTests } =
    await import('../mongoMirror.js');

  __resetForTests();
  __setCollectionForTests(fakeCollection);

  const foreignBeat = () => fakeCollection.updateOne(
    { _id: '.aqua-mirror-writer' },
    { $set: { instanceId: 'other-host:999:beef', ts: Date.now() + 1 } });

  await __heartbeatOnceForTests();                       // claim the lock
  assert.equal(getMirrorStatus().multiWriterConflict, false);

  // Deploy overlap: ONE foreign beat, then silence → no alarm, grace resets.
  await foreignBeat();
  await __heartbeatOnceForTests();
  await __heartbeatOnceForTests();
  assert.equal(getMirrorStatus().multiWriterConflict, false, 'a single overlap beat must not alarm');

  // Persistent second writer: keeps beating between our beats → alarm at 3 strikes.
  for (let i = 0; i < 3; i++) { await foreignBeat(); await __heartbeatOnceForTests(); }
  const status = getMirrorStatus();
  assert.equal(status.multiWriterConflict, true, 'ping-ponging writers must raise the alarm');
  assert.equal(status.conflictWith, 'other-host:999:beef');
  __resetForTests();
});
