/**
 * Phase 4a — checkpointEngine tests (real workspace + index, no LLM).
 * Run: node src/project/tests/checkpointEngine.test.js
 */
import assert from 'node:assert';
import fs   from 'fs';
import os   from 'os';
import path from 'path';

const realCwd = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-cp-'));
process.chdir(dir); // isolate .aqua-*.json writes

const { createWorkspace, updateWorkspace } = await import('../workspaceManager.js');
const { buildIndex, getIndex } = await import('../projectIndex.js');
const { createCheckpoint, restoreCheckpoint, listCheckpoints, deleteCheckpoint, __clearAllForTests } = await import('../checkpointEngine.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (e) { failed++; console.error(`  \u2717 ${name}\n    ${e.message}`); }
}

function freshWorkspace(files) {
  const ws = createWorkspace({ name: 'cp-test' });
  buildIndex(ws.id, files);
  updateWorkspace(ws.id, { indexStatus: 'indexed' });
  return ws.id;
}

console.log('checkpointEngine — create + guards');
await test('create fails on unknown workspace', () => {
  __clearAllForTests();
  const r = createCheckpoint('nope');
  assert.equal(r.ok, false);
});
await test('create captures current file count', () => {
  const wsId = freshWorkspace([
    { path: 'a.js', content: 'export const a = 1;', lang: 'js', size: 20 },
    { path: 'b.js', content: 'export const b = 2;', lang: 'js', size: 20 },
  ]);
  const r = createCheckpoint(wsId, { label: 'start' });
  assert.equal(r.ok, true);
  assert.equal(r.checkpoint.fileCount, 2);
  assert.equal(r.checkpoint.label, 'start');
});

console.log('checkpointEngine — restore round-trip');
await test('restores original content after the index was mutated', () => {
  __clearAllForTests();
  const wsId = freshWorkspace([
    { path: 'core.js', content: 'export function orig(){ return 1; }', lang: 'js', size: 40 },
  ]);
  const cp = createCheckpoint(wsId, { label: 'good' }).checkpoint;

  // Mutate the workspace: replace core.js with different content + add a file.
  buildIndex(wsId, [
    { path: 'core.js', content: 'export function CHANGED(){ return 999; }', lang: 'js', size: 45 },
    { path: 'extra.js', content: 'export const x = 1;', lang: 'js', size: 20 },
  ]);
  assert.ok(getIndex(wsId).byPath.get('core.js').content.includes('CHANGED'), 'mutation applied');
  assert.ok(getIndex(wsId).byPath.has('extra.js'), 'extra file present pre-restore');

  const r = restoreCheckpoint(wsId, cp.id);
  assert.equal(r.ok, true);
  const restored = getIndex(wsId);
  assert.ok(restored.byPath.get('core.js').content.includes('orig'), 'original content restored');
  assert.ok(!restored.byPath.get('core.js').content.includes('CHANGED'), 'mutation gone');
  assert.ok(!restored.byPath.has('extra.js'), 'file added after checkpoint removed on restore');
});
await test('restore rebuilds the index entry from the checkpoint (editable/retrievable after restore)', () => {
  __clearAllForTests();
  const wsId = freshWorkspace([{ path: 'm.js', content: 'export function alpha(){}', lang: 'js', size: 30 }]);
  const cp = createCheckpoint(wsId).checkpoint;
  buildIndex(wsId, [{ path: 'm.js', content: 'export function beta(){}', lang: 'js', size: 30 }]);
  restoreCheckpoint(wsId, cp.id);
  const entry = getIndex(wsId).byPath.get('m.js');
  assert.ok(entry, 'index entry rebuilt after restore');
  assert.ok(entry.content.includes('alpha') && !entry.content.includes('beta'), 'entry rebuilt from checkpoint content, not the mutated version');
});
await test('restore of unknown checkpoint fails cleanly', () => {
  const wsId = freshWorkspace([{ path: 'a.js', content: 'x', lang: 'js', size: 1 }]);
  const r = restoreCheckpoint(wsId, 'no-such-id');
  assert.equal(r.ok, false);
});

console.log('checkpointEngine — list / delete / eviction');
await test('list returns newest first', async () => {
  __clearAllForTests();
  const wsId = freshWorkspace([{ path: 'a.js', content: 'x', lang: 'js', size: 1 }]);
  const c1 = createCheckpoint(wsId, { label: 'one' }).checkpoint;
  await new Promise(r => setTimeout(r, 5));
  const c2 = createCheckpoint(wsId, { label: 'two' }).checkpoint;
  const list = listCheckpoints(wsId);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, c2.id, 'newest first');
  assert.equal(list[1].id, c1.id);
});
await test('delete removes a checkpoint', () => {
  __clearAllForTests();
  const wsId = freshWorkspace([{ path: 'a.js', content: 'x', lang: 'js', size: 1 }]);
  const cp = createCheckpoint(wsId).checkpoint;
  assert.equal(deleteCheckpoint(wsId, cp.id).ok, true);
  assert.equal(listCheckpoints(wsId).length, 0);
});
await test('caps at 20 checkpoints per workspace (evicts oldest)', () => {
  __clearAllForTests();
  const wsId = freshWorkspace([{ path: 'a.js', content: 'x', lang: 'js', size: 1 }]);
  for (let i = 0; i < 25; i++) createCheckpoint(wsId, { label: `cp${i}` });
  assert.equal(listCheckpoints(wsId).length, 20, 'bounded at cap');
});

process.chdir(realCwd);
// Let any pending debounced store writes flush to the (still-existing) temp dir
// before we remove it — avoids a cosmetic post-teardown ENOENT from a writer
// that outlives the test. The writes are fail-open regardless.
await new Promise(r => setTimeout(r, 700));
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\ncheckpointEngine: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
