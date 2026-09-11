/**
 * Reflection durability, and the revision history it makes possible.
 *
 * THE DEFECT
 * ----------
 * The diff baseline lived in a module-level `Map`. Measured across a real
 * process boundary, same data dir, no new turns between the last two:
 *
 *   run 1, reflect       → 5 entities changed   (correct)
 *   run 1, reflect again → 0 changed            (correct)
 *   RESTART, reflect     → 5 entities changed   ← fabricated
 *
 * An empty `before` makes every node look new, so the first reflection after
 * every deploy claimed every active user's whole world model had just changed.
 * With AQUA_REFLECT_V2=on the applier ACTS on that, and the feature's entire
 * purpose is telling someone what AQUA changed its mind about — so its first
 * output after each deploy was a lie.
 *
 * THE SECOND HALF
 * ---------------
 * `turnPostProcess` calls `reflectTurn(ownerId)` and discards the return value,
 * so the WorldDelta was computed, applied, logged and dropped. There was no
 * history to read and nothing a user could ever be shown.
 *
 * Proven to bite: reverting the durable store to a Map fails exactly the three
 * wiring cases. The store's own behaviour tests pass in both directions on
 * purpose — they describe a contract, not a repair.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  loadSnapshot, loadWatermark, saveReflectionState,
  forgetReflectionState, reflectionStoreStats, _resetReflectionStoreForTests,
} from '../reflectionV2/reflectionStore.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const snap = (ids, at = 1000) => ({
  nodes: new Map(ids.map(i => [i, { id: i, label: i, sourceCount: 1, type: 'name' }])),
  edges: new Map(),
  takenAt: at,
});

// ── The baseline survives ────────────────────────────────────────────────────

test('a saved snapshot reads back with its Maps intact', () => {
  _resetReflectionStoreForTests();
  saveReflectionState('user:a', snap(['ent:1', 'ent:2']), 5000);
  const got = loadSnapshot('user:a');
  assert.ok(got.nodes instanceof Map, 'nodes came back as something other than a Map');
  assert.equal(got.nodes.size, 2);
  assert.equal(loadWatermark('user:a'), 5000);
});

test('an owner never reflected on returns null, not an empty snapshot', () => {
  // The caller owns the "what does empty look like" default. Returning a
  // fabricated empty snapshot here would hide a first-run from the caller.
  _resetReflectionStoreForTests();
  assert.equal(loadSnapshot('user:never'), null);
  assert.equal(loadWatermark('user:never'), 0);
});

test('owners are isolated', () => {
  _resetReflectionStoreForTests();
  saveReflectionState('user:a', snap(['ent:1']), 100);
  saveReflectionState('user:b', snap(['ent:9', 'ent:8']), 200);
  assert.equal(loadSnapshot('user:a').nodes.size, 1);
  assert.equal(loadSnapshot('user:b').nodes.size, 2);
  assert.equal(loadWatermark('user:a'), 100);
});

test('forgetting an owner clears both halves', () => {
  _resetReflectionStoreForTests();
  saveReflectionState('user:a', snap(['ent:1']), 100);
  forgetReflectionState('user:a');
  assert.equal(loadSnapshot('user:a'), null);
  assert.equal(loadWatermark('user:a'), 0);
});

test('a missing owner id is a no-op, never a throw', () => {
  _resetReflectionStoreForTests();
  saveReflectionState(null, snap(['x']), 1);
  assert.equal(loadSnapshot(null), null);
  assert.equal(loadWatermark(undefined), 0);
});

test('the store persists fingerprints only — never knowledge', () => {
  // Entities live in the graph, facts in evidenceStore, beliefs in the Mind.
  // If a statement ever reaches this store it has become a competing knowledge
  // store and the PIC constraint is broken. Asserted on the SHAPE, not on the
  // prose — an earlier draft of this test grepped the file for the word "fact"
  // and failed on its own explanatory comment, which proved nothing either way.
  _resetReflectionStoreForTests();
  const withExtras = {
    nodes: new Map([['ent:1', { id: 'ent:1', label: 'Nummo', sourceCount: 1, type: 'org' }]]),
    edges: new Map(),
    takenAt: 42,
  };
  saveReflectionState('user:shape', withExtras, 42);
  const got = loadSnapshot('user:shape');
  const node = got.nodes.get('ent:1');
  assert.deepEqual(Object.keys(node).sort(), ['id', 'label', 'sourceCount', 'type']);
  assert.deepEqual(Object.keys(got).sort(), ['edges', 'nodes', 'takenAt']);
  const stats = reflectionStoreStats();
  assert.equal(stats.owners, 1);
  assert.equal(stats.nodes, 1);
});

// ── The wiring ───────────────────────────────────────────────────────────────

const IDX = readFileSync(path.join(HERE, '..', 'reflectionV2', 'index.js'), 'utf8');

test('the baseline is READ from the durable store, not a Map', () => {
  assert.match(IDX, /const before = loadSnapshot\(ownerId\)/);
  assert.ok(!/const before = snapshots\.get\(ownerId\)/.test(IDX));
});

test('the obsolescence watermark is durable too', () => {
  // Losing it resets `since` to 0, which rescans an owner's entire fact corpus
  // instead of what arrived since the last reflection. Quieter symptom, same
  // cause.
  assert.match(IDX, /const since = loadWatermark\(ownerId\)/);
});

test('state rolls forward to disk on every reflection', () => {
  assert.match(IDX, /saveReflectionState\(ownerId, after, after\.takenAt\)/);
});

// ── The history ──────────────────────────────────────────────────────────────

test('a real delta is recorded to the ledger; a no-change reflection is not', () => {
  // "Nothing changed" is not an event, and a feed full of them is noise.
  const guarded = IDX.slice(IDX.indexOf('// 6. RECORD IT'));
  assert.match(guarded, /if \(delta\.worldModelUpdated\)/);
  assert.match(guarded, /ledger\(ownerId, 'reflection'/);
});

test('the ledger write cannot break reflection', () => {
  // Bookkeeping is the least important thing in this function.
  //
  // The window is measured from the try to the catch rather than a fixed byte
  // count: an earlier version used `slice(i - 200, i + 500)` and broke the
  // moment the ledger entry grew to carry named subjects. A test that fails
  // because the code it guards got longer is testing the wrong thing.
  const i = IDX.indexOf("ledger(ownerId, 'reflection'");
  assert.ok(i > -1, 'the ledger write is gone');
  const openTry = IDX.lastIndexOf('try {', i);
  const nextCatch = IDX.indexOf('catch', i);
  assert.ok(openTry > -1 && nextCatch > i, 'the ledger write is not inside a try/catch');
  assert.ok(nextCatch - openTry < 3000, 'the guarding try/catch is suspiciously far away');
});
