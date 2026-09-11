/**
 * P0 stabilization sprint — new persistence guarantees.
 * Covers the machinery that makes chats/memory survive deployments:
 *   • dataDir: legacy cwd file migrates loss-proof into the data dir
 *   • loadJsonFile: corrupt store preserved aside + recovered from .bak
 *   • conversationStore v4: server-side title/pin/archive meta, updatedAt,
 *     no 200-message rolling delete, delete → trash snapshot
 * Run: node --test src/core/tests/p0Persistence.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs   from 'fs';
import os   from 'os';
import path from 'path';

// Pin an isolated data dir + cwd BEFORE any store import.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-p0-data-'));
const cwdDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-p0-cwd-'));
process.env.AQUA_DATA_DIR = dataDir;
process.chdir(cwdDir);

// Seed a LEGACY history file in the fake deploy tree (old cwd contract).
const legacyHistory = {
  'conv-legacy': { messages: [{ role: 'user', content: 'from the old world', ts: 1 }], meta: { userId: 'u9', createdAt: 1 } },
};
fs.writeFileSync(path.join(cwdDir, '.aqua-history.json'), JSON.stringify(legacyHistory));

let bust = 0;
const fresh = (rel) => import(`${new URL(rel, import.meta.url).href}?p0=${bust++}`);

test('dataDir — legacy cwd file migrates into the data dir, original kept as backup', async () => {
  const store = await fresh('../../memory/conversationStore.js');
  // Loaded through the migrated file:
  const msgs = store.getConversation('conv-legacy');
  assert.equal(msgs.length, 1, 'legacy conversation loaded');
  assert.ok(fs.existsSync(path.join(dataDir, '.aqua-history.json')), 'file now lives in data dir');
  assert.ok(fs.existsSync(path.join(cwdDir, '.aqua-history.json.migrated-to-datadir')), 'original preserved as backup');
  assert.ok(!fs.existsSync(path.join(cwdDir, '.aqua-history.json')), 'no live legacy file left to double-load');
});

test('conversationStore — meta patch (title/pin/archive) is whitelisted + stamped', async () => {
  const store = await fresh('../../memory/conversationStore.js');
  const { id } = store.getOrCreateConversation(null, { userId: 'u1' });
  const meta = store.updateConversationMeta(id, {
    title: '  My Sprint Plan  ',
    pinned: 1,
    archived: false,
    userId: 'EVIL',          // not whitelisted — must be ignored
    createdAt: 0,            // not whitelisted — must be ignored
  });
  assert.equal(meta.title, 'My Sprint Plan', 'title trimmed');
  assert.equal(meta.pinned, true, 'pinned coerced to boolean');
  assert.equal(meta.archived, false);
  assert.equal(meta.userId, 'u1', 'identity fields untouchable via patch');
  assert.ok(meta.updatedAt > 0, 'updatedAt stamped');
  assert.equal(store.updateConversationMeta('nope', { title: 'x' }), null, 'missing id → null');
});

test('conversationStore — messages are no longer rolling-deleted at 200', async () => {
  const store = await fresh('../../memory/conversationStore.js');
  const { id } = store.getOrCreateConversation(null, {});
  for (let i = 0; i < 250; i++) store.addMessage(id, 'user', `m${i}`);
  const msgs = store.getConversation(id);
  assert.equal(msgs.length, 250, 'all 250 messages retained (old cap silently deleted 50)');
  assert.equal(msgs[0].content, 'm0', 'oldest message still present');
});

test('conversationStore — delete snapshots the conversation into trash first', async () => {
  const store = await fresh('../../memory/conversationStore.js');
  const { id } = store.getOrCreateConversation(null, { userId: 'u2' });
  store.addMessage(id, 'user', 'precious');
  store.clearConversation(id);
  assert.equal(store.conversationExists(id), false, 'gone from the live store');
  const trash = JSON.parse(fs.readFileSync(path.join(dataDir, '.aqua-history-trash.json'), 'utf8'));
  const entry = trash.find(t => t.id === id);
  assert.ok(entry, 'trash entry written before delete');
  assert.equal(entry.messages[0].content, 'precious', 'full message payload recoverable');
});

test('atomicStore — corrupt file is preserved aside and recovered from .bak', async () => {
  const { loadJsonFile } = await fresh('../atomicStore.js');
  const f = path.join(dataDir, 'victim.json');
  fs.writeFileSync(`${f}.bak`, JSON.stringify({ ok: true, from: 'bak' }));
  fs.writeFileSync(f, '{"truncated: ');
  const recovered = loadJsonFile(f, { label: 'victim' });
  assert.equal(recovered?.from, 'bak', 'recovered from .bak');
  const aside = fs.readdirSync(dataDir).find(n => n.startsWith('victim.json.corrupt-'));
  assert.ok(aside, 'corrupt bytes preserved for manual recovery');
});

test('atomicStore — schema envelope: legacy bare object still loads (schema 0)', async () => {
  const { unwrapStore, wrapStore } = await fresh('../atomicStore.js');
  const bare = unwrapStore({ a: 1 });
  assert.equal(bare.schema, 0);
  assert.deepEqual(bare.data, { a: 1 });
  const env = unwrapStore(wrapStore(3, { b: 2 }));
  assert.equal(env.schema, 3);
  assert.deepEqual(env.data, { b: 2 });
});
