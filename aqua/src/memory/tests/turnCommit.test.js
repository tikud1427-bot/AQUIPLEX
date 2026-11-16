/**
 * memory/turnCommit.js — unit snapshots, the 3-way revert and the transaction
 * contract (Sprint 1 Task D, 2026-11-10). Route-level behaviour:
 * routes/tests/failedTurnMemory.test.js.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-turn-commit-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
process.env.AQUA_EMBEDDINGS = 'off';

const { snapshotUnits, diffUnits, beginTurnMemory, noteTurnForget, sealTurnMemory, commitTurnMemory, rollbackTurnMemory } = await import('../turnCommit.js');
const { getMind, peekMind } = await import('../../mind/mindStore.js');
const { storeFact, getFacts } = await import('../longTermMemory.js');
const { memoryObserve } = await import('../engine.js');

const SEP = '\u0000';

describe('units: one per item, graph one level deeper, only changes kept', () => {
  test('a Mind splits into item units', () => {
    const u = snapshotUnits({ turnCount: 3, facts: { name: { value: 'A' } }, graph: { nodes: { n1: { label: 'x' } }, edges: {} }, working: { blockers: ['b'] } });
    assert.equal(u.get('turnCount'), '3');
    assert.equal(u.get(`facts${SEP}name`), '{"value":"A"}');
    assert.equal(u.get(`graph${SEP}nodes${SEP}n1`), '{"label":"x"}');
    assert.equal(u.get(`working${SEP}blockers`), '["b"]');
  });
  test('diffUnits reports created, changed and deleted units only', () => {
    const d = diffUnits(snapshotUnits({ facts: { a: 1, b: 2 } }), snapshotUnits({ facts: { a: 1, b: 3, c: 4 } }));
    assert.deepEqual([...d.keys()].sort(), [`facts${SEP}b`, `facts${SEP}c`]);
    const del = diffUnits(snapshotUnits({ facts: { a: 1 } }), snapshotUnits({ facts: {} }));
    assert.deepEqual(del.get(`facts${SEP}a`), { before: '1', after: undefined });
  });
});

function txnOn(owner, mutate) {
  const mind = getMind(owner);
  const t = beginTurnMemory(owner);
  mutate(mind);
  sealTurnMemory(t);
  return { t, mind };
}

describe('the 3-way revert on a live Mind', () => {
  test('changed → back, created → removed, deleted → back; untouched units untouched', () => {
    const owner = 'user:units-1';
    const m = getMind(owner);
    m.facts.keep = { value: 'k' }; m.facts.changeMe = { value: 'old' }; m.facts.dropMe = { value: 'd' };
    const { t, mind } = txnOn(owner, x => { x.facts.changeMe = { value: 'new' }; x.facts.created = { value: 'c' }; delete x.facts.dropMe; });
    rollbackTurnMemory(t);
    assert.deepEqual(mind.facts.keep, { value: 'k' });
    assert.deepEqual(mind.facts.changeMe, { value: 'old' });
    assert.equal(mind.facts.created, undefined);
    assert.deepEqual(mind.facts.dropMe, { value: 'd' });
    assert.ok(mind.tombstones?.facts?.created > 0, 'removed key tombstoned (merge-at-flush cannot resurrect it)');
  });
  test('a unit changed again after the seal (another request) is kept', () => {
    const owner = 'user:units-2';
    getMind(owner).facts.n = { value: 1 };
    const { t, mind } = txnOn(owner, x => { x.facts.n = { value: 2 }; x.facts.mine = { value: 'turn' }; });
    mind.facts.n = { value: 99 };                       // concurrent change after the seal
    const r = rollbackTurnMemory(t);
    assert.deepEqual(mind.facts.n, { value: 99 });
    assert.equal(mind.facts.mine, undefined);
    assert.equal(r.kept, 1);
  });
  test('nested graph items revert individually', () => {
    const owner = 'user:units-3';
    const m = getMind(owner); m.graph = { nodes: { a: { l: 'A' } }, edges: {} };
    const { t, mind } = txnOn(owner, x => { x.graph.nodes.b = { l: 'B' }; x.graph.edges.ab = { from: 'a', to: 'b' }; });
    mind.graph.nodes.c = { l: 'C' };                    // concurrent
    rollbackTurnMemory(t);
    assert.deepEqual(Object.keys(mind.graph.nodes).sort(), ['a', 'c']);
    assert.deepEqual(mind.graph.edges, {});
  });
});

describe('the transaction with real observation', () => {
  test('rollback undoes facts and Mind state learned from the turn', () => {
    const owner = 'user:txn-1';
    storeFact(owner, { key: 'city', value: 'Lisbon', confidence: 0.9, importance: 6, sourceText: 'I live in Lisbon', ts: Date.now() });
    const before = JSON.stringify(getFacts(owner));
    const goalsBefore = JSON.stringify(peekMind(owner).goals);
    const txn = beginTurnMemory(owner, { requestId: 'r1' });
    const obs = memoryObserve(owner, { userMessage: 'My name is Quillon and my goal is to learn Rust.', defer: txn.defer });
    noteTurnForget(txn, obs.trace.forget);
    sealTurnMemory(txn);
    assert.ok(getFacts(owner).some(f => f.key === 'name'), 'control: observation stored the name');
    const report = rollbackTurnMemory(txn, { reason: 'test' });
    assert.ok(report.reverted > 0);
    assert.equal(JSON.stringify(getFacts(owner)), before, 'facts exactly as before the turn');
    assert.equal(JSON.stringify(peekMind(owner).goals), goalsBefore, 'goals exactly as before');
  });

  test('rollback before the seal (preparation threw midway) still undoes the turn', () => {
    const owner = 'user:txn-unsealed';
    const txn = beginTurnMemory(owner);
    memoryObserve(owner, { userMessage: 'My name is Orrin.', defer: txn.defer });
    rollbackTurnMemory(txn);
    assert.equal(getFacts(owner).find(f => f.key === 'name'), undefined);
  });

  test('commit keeps everything and is idempotent; rollback after commit is a no-op', () => {
    const owner = 'user:txn-2';
    const txn = beginTurnMemory(owner);
    memoryObserve(owner, { userMessage: 'My name is Pellamy.', defer: txn.defer });
    sealTurnMemory(txn);
    assert.equal(commitTurnMemory(txn), true);
    assert.equal(commitTurnMemory(txn), false);
    assert.equal(rollbackTurnMemory(txn), null);
    assert.equal(getFacts(owner).find(f => f.key === 'name')?.value, 'Pellamy');
  });

  test('deferred background effects run at commit and never after a rollback', () => {
    let ran = 0;
    const a = beginTurnMemory('user:txn-3'); a.defer(() => { ran++; }); sealTurnMemory(a); rollbackTurnMemory(a);
    assert.equal(ran, 0);
    const b = beginTurnMemory('user:txn-3'); b.defer(() => { ran++; }); sealTurnMemory(b); commitTurnMemory(b);
    assert.equal(ran, 1);
  });

  test('a FORGET in a failed turn is still honoured', () => {
    const owner = 'user:txn-4';
    storeFact(owner, { key: 'workplace', value: 'Fintrail', confidence: 0.9, importance: 7, sourceText: 'I work at Fintrail', ts: Date.now() });
    const txn = beginTurnMemory(owner);
    // Statement first, forget last: the chat forget detector takes EVERYTHING after
    // "forget my" as the hint ("Forget my workplace. Also my name is X" resolves to
    // `name` — a pre-existing defect recorded in AQUIPLEX_SPRINT1_PRODUCTION_SAFETY_REPORT.md).
    const obs = memoryObserve(owner, { userMessage: 'My name is Dorran. Forget my workplace', defer: txn.defer });
    noteTurnForget(txn, obs.trace.forget);
    sealTurnMemory(txn);
    assert.ok(obs.trace.forget?.deleted, 'control: the forget was recognised');
    const report = rollbackTurnMemory(txn);
    assert.equal(report.forgetsHonoured, 1);
    assert.equal(getFacts(owner).find(f => f.key === 'workplace'), undefined, 'still forgotten');
    assert.equal(getFacts(owner).find(f => f.key === 'name'), undefined, 'but nothing new was learned');
  });

  test('a concurrent turn\'s knowledge survives the failed turn\'s rollback', () => {
    const owner = 'user:txn-5';
    const failing = beginTurnMemory(owner);
    memoryObserve(owner, { userMessage: 'My name is Vantor.', defer: failing.defer });
    sealTurnMemory(failing);
    const ok = beginTurnMemory(owner);
    memoryObserve(owner, { userMessage: 'I live in Bergen.', defer: ok.defer });
    sealTurnMemory(ok); commitTurnMemory(ok);
    rollbackTurnMemory(failing);
    const facts = getFacts(owner);
    assert.equal(facts.find(f => f.key === 'name'), undefined, 'the failed turn\'s fact is gone');
    assert.ok(facts.some(f => /bergen/i.test(String(f.value))), 'the concurrent turn\'s fact stays');
  });

  test('no owner → no transaction (memory disabled)', () => {
    assert.equal(beginTurnMemory(null), null);
    assert.equal(rollbackTurnMemory(null), null);
    assert.equal(commitTurnMemory(null), false);
  });
});
