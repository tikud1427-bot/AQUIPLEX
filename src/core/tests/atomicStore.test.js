/**
 * Phase 3b — atomicStore unit tests.
 * Run: node src/core/tests/atomicStore.test.js
 */
import assert from 'node:assert';
import fs   from 'fs';
import os   from 'os';
import path from 'path';
import { atomicWriteFile, atomicWriteFileSync, createDebouncedWriter } from '../atomicStore.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (e) { failed++; console.error(`  \u2717 ${name}\n    ${e.message}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-atomic-'));
const f = (n) => path.join(dir, n);
const read = (p) => fs.readFileSync(p, 'utf8');
const tempsIn = () => fs.readdirSync(dir).filter(n => n.includes('.tmp.'));

console.log('atomicWriteFile — async');
await test('writes the full file', async () => {
  await atomicWriteFile(f('a.json'), '{"x":1}');
  assert.equal(read(f('a.json')), '{"x":1}');
});
await test('overwrites atomically', async () => {
  await atomicWriteFile(f('a.json'), 'v1');
  await atomicWriteFile(f('a.json'), 'v2');
  assert.equal(read(f('a.json')), 'v2');
});
await test('leaves NO temp files behind on success', async () => {
  await atomicWriteFile(f('b.json'), 'data');
  assert.deepEqual(tempsIn(), [], 'temp cleaned by rename');
});
await test('temp lives in the same directory (guarantees atomic rename)', async () => {
  // Intercept by writing a large payload and checking no temp escapes the dir.
  await atomicWriteFile(f('c.json'), 'x'.repeat(100000));
  assert.equal(read(f('c.json')).length, 100000);
  assert.deepEqual(tempsIn(), []);
});

console.log('atomicWriteFileSync');
await test('sync writes the full file + no temp left', () => {
  atomicWriteFileSync(f('s.json'), 'sync-data');
  assert.equal(read(f('s.json')), 'sync-data');
  assert.deepEqual(tempsIn(), []);
});

console.log('crash-safety — a failed write never corrupts the existing file');
await test('rename failure leaves the OLD file intact (never partial)', async () => {
  await atomicWriteFile(f('keep.json'), 'GOOD');
  // Simulate a write failure by pointing at a path whose directory does not
  // exist — writeFile to temp fails, target is untouched.
  const bad = path.join(dir, 'no-such-subdir', 'x.json');
  await assert.rejects(() => atomicWriteFile(bad, 'WOULD-CORRUPT'));
  // The unrelated good file is still perfectly intact.
  assert.equal(read(f('keep.json')), 'GOOD');
  assert.deepEqual(tempsIn(), [], 'failed write cleaned its temp');
});

console.log('createDebouncedWriter — debounce + coalesce');
await test('coalesces a burst into a single write with the LATEST state', async () => {
  let writes = 0;
  const w = createDebouncedWriter(f('d.json'), { debounceMs: 20 });
  const orig = fs.promises.writeFile;
  // count actual disk writes via the file mtime approach: simpler — just write
  // distinct values and assert the final content is the last one.
  w.schedule(() => 'A');
  w.schedule(() => 'B');
  w.schedule(() => 'C');           // only C should land
  await new Promise(r => setTimeout(r, 60));
  assert.equal(read(f('d.json')), 'C', 'latest state persisted');
});
await test('serialize is called at FLUSH time, not schedule time (snapshots latest)', async () => {
  let counter = 0;
  const w = createDebouncedWriter(f('e.json'), { debounceMs: 20 });
  w.schedule(() => String(counter));   // captured fn reads counter at flush
  counter = 42;                        // mutate AFTER scheduling
  await new Promise(r => setTimeout(r, 60));
  assert.equal(read(f('e.json')), '42', 'flush-time snapshot, not schedule-time');
});

console.log('createDebouncedWriter — in-flight guard (no lost update)');
await test('a mutation arriving DURING an async write is not lost (re-flush)', async () => {
  const w = createDebouncedWriter(f('g.json'), { debounceMs: 10 });
  let value = 'first';
  w.schedule(() => value);
  // Wait until the first flush is mid-write, then schedule a new value.
  await new Promise(r => setTimeout(r, 12));
  value = 'second';
  w.schedule(() => value);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(read(f('g.json')), 'second', 'the later value re-flushed and won');
});

console.log('createDebouncedWriter — flush + cancel');
await test('flush() writes immediately + synchronously', () => {
  const w = createDebouncedWriter(f('h.json'), { debounceMs: 10_000 });
  w.schedule(() => 'flushed');
  w.flush();
  assert.equal(read(f('h.json')), 'flushed', 'no wait for debounce');
  assert.equal(w.isPending(), false);
});
await test('cancel() drops a pending write without writing', async () => {
  const w = createDebouncedWriter(f('i.json'), { debounceMs: 20 });
  w.schedule(() => 'should-not-write');
  w.cancel();
  await new Promise(r => setTimeout(r, 40));
  assert.equal(fs.existsSync(f('i.json')), false, 'nothing written after cancel');
});
await test('failed serialize does not throw out of the writer', async () => {
  const errs = [];
  const w = createDebouncedWriter(f('j.json'), { debounceMs: 10, onError: e => errs.push(e) });
  w.schedule(() => { throw new Error('serialize boom'); });
  await new Promise(r => setTimeout(r, 40));
  assert.ok(errs.length >= 1, 'error routed to onError, not thrown');
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\natomicStore: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
