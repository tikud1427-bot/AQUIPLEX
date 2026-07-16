/**
 * Phase 3b — store persistence round-trip through the atomic writer.
 * For each converted store: mutate → flush (atomic) → reload in a FRESH module
 * instance (simulated restart) → assert data survived + the on-disk file is
 * valid JSON (never a partial write). Uses an isolated cwd so it never touches
 * real .aqua-*.json files.
 * Run: node src/core/tests/storePersistence.test.js
 */
import assert from 'node:assert';
import fs   from 'fs';
import os   from 'os';
import path from 'path';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (e) { failed++; console.error(`  \u2717 ${name}\n    ${e.message}`); }
}

// Isolate persistence in a temp DATA DIR — stores resolve their files from
// the canonical data directory now (core/dataDir.js), pinned here via env
// BEFORE any store module is imported. cwd is also moved so the legacy-file
// migration path sees an empty deploy tree.
const realCwd = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-persist-'));
process.env.AQUA_DATA_DIR = dir;
process.chdir(dir);

// Cache-bust dynamic imports so a "reload" gets a fresh module instance whose
// load-on-boot reads the file the previous instance wrote.
let bust = 0;
const fresh = (rel) => import(`${new URL(rel, import.meta.url).href}?v=${bust++}`);

const isValidJsonFile = (name) => {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return false;
  JSON.parse(fs.readFileSync(p, 'utf8')); // throws on partial/corrupt
  return true;
};

console.log('round-trip — conversationStore (.aqua-history.json)');
await test('messages persist across a restart', async () => {
  const s1 = await fresh('../../memory/conversationStore.js');
  const { id } = s1.getOrCreateConversation(null, { userId: 'u1' });
  s1.addMessage(id, 'user', 'hello durability');
  s1._flushForTests ? s1._flushForTests() : s1.__flush?.();
  // No test flush export — force via the writer's debounce by waiting.
  await new Promise(r => setTimeout(r, 700));
  assert.ok(isValidJsonFile('.aqua-history.json'), 'valid JSON on disk');

  const s2 = await fresh('../../memory/conversationStore.js');
  const msgs = s2.getConversation(id);
  assert.ok(msgs.some(m => m.content === 'hello durability'), 'message survived restart');
});

console.log('round-trip — mindStore (.aqua-mind.json)');
await test('a fact inside a mind persists across a restart', async () => {
  const m1 = await fresh('../../mind/mindStore.js');
  const mind = m1.getMind('user:persist1');
  mind.facts['favorite_language'] = { value: 'Rust', confidence: 0.9 };
  m1.touchMind(mind);
  await new Promise(r => setTimeout(r, 700));
  assert.ok(isValidJsonFile('.aqua-mind.json'));

  const m2 = await fresh('../../mind/mindStore.js');
  const reloaded = m2.peekMind('user:persist1');
  assert.equal(reloaded?.facts?.favorite_language?.value, 'Rust', 'fact survived restart');
});

console.log('round-trip — projectMemory (.aqua-projects.json)');
await test('a workspace persists across a restart', async () => {
  const p1 = await fresh('../../project/workspaceManager.js');
  const ws = p1.createWorkspace({ name: 'durable-ws' });
  await new Promise(r => setTimeout(r, 700));
  assert.ok(isValidJsonFile('.aqua-projects.json'));

  const p2 = await fresh('../../project/workspaceManager.js');
  assert.ok(p2.getWorkspace(ws.id), 'workspace survived restart');
});

console.log('round-trip — projectIndex (.aqua-index.json)');
await test('an index source snapshot persists across a restart', async () => {
  const i1 = await fresh('../../project/projectIndex.js');
  i1.buildIndex('ws-durable', [{ path: 'a.js', content: 'export const x=1;', lang: 'js', size: 20 }]);
  await new Promise(r => setTimeout(r, 700));
  assert.ok(isValidJsonFile('.aqua-index.json'));

  const i2 = await fresh('../../project/projectIndex.js');
  const idx = i2.getIndex('ws-durable');   // rebuilds from persisted source snapshot
  assert.ok(idx?.byPath?.has('a.js'), 'index rebuilt from persisted source after restart');
});

console.log('round-trip — vectorStore (.aqua-vectors.json)');
await test('vectors persist across a restart (persist enabled)', async () => {
  const v1 = await fresh('../../embeddings/vectorStore.js');
  v1.__resetForTests({ disablePersist: false });   // enable disk for this test
  v1.upsert('ns-durable', 'id1', [1, 0, 0], 'h1');
  await new Promise(r => setTimeout(r, 700));
  assert.ok(isValidJsonFile('.aqua-vectors.json'));

  const v2 = await fresh('../../embeddings/vectorStore.js');
  assert.deepEqual(v2.getVec('ns-durable', 'id1'), [1, 0, 0], 'vector survived restart');
});

process.chdir(realCwd);
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nstorePersistence: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
