/**
 * Three-way entry merge (Phase 2c) — pure. The semantics every remaining store
 * relies on: who changed what is decided against the BASE, never by a clock.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mergeEntry, mergeItem, mergeSet, stable } from '../storage/entryMerge.js';

const root = { root: {} };

describe('three-way merge — items', () => {
  test('an item changed on one side only takes that side, whatever the clocks say', () => {
    const b = { x: { v: 1, updatedAt: 500 } };
    const o = { x: { v: 2, updatedAt: 100 } };        // our edit, stamped by a SLOW clock
    const t = b;                                       // untouched there
    assert.deepEqual(mergeEntry(o, t, b, root), o);
  });
  test('both sides added different items: both kept', () => {
    assert.deepEqual(Object.keys(mergeEntry({ a: { v: 1 } }, { b: { v: 2 } }, {}, root)).sort(), ['a', 'b']);
  });
  test('an item deleted on one side and untouched on the other is gone — no tombstone needed', () => {
    const b = { keep: { v: 1 }, gone: { v: 1 } };
    assert.deepEqual(mergeEntry({ keep: { v: 1 } }, b, b, root), { keep: { v: 1 } });   // we deleted
    assert.deepEqual(mergeEntry(b, { keep: { v: 1 } }, b, root), { keep: { v: 1 } });   // they deleted
  });
  test('delete here, edit there: the edit wins (a change is never lost silently)', () => {
    const b = { x: { v: 1 } };
    assert.deepEqual(mergeEntry({}, { x: { v: 9 } }, b, root), { x: { v: 9 } });
  });
  test('both edited: the newer item wins; counter fields add both sides\' increments', () => {
    const spec = { time: x => x.lastAt, counters: ['ok', 'bad'] };
    const r = mergeItem({ ok: 5, bad: 1, lastAt: 20 }, { ok: 4, bad: 2, lastAt: 10 }, { ok: 3, bad: 1, lastAt: 1 }, spec);
    assert.equal(r.ok, 6);    // 3 + (5-3) + (4-3)
    assert.equal(r.bad, 2);   // 1 + 0 + 1
    assert.equal(r.lastAt, 20);
  });
  test('without a base (never loaded here): union, newer item wins, nothing deleted', () => {
    const r = mergeEntry({ a: { v: 1, updatedAt: 2 } }, { a: { v: 2, updatedAt: 3 }, b: { v: 1 } }, undefined, root);
    assert.deepEqual(r, { a: { v: 2, updatedAt: 3 }, b: { v: 1 } });
  });
  test('order-independent when both sides changed different items', () => {
    const b = { a: { v: 0 }, b: { v: 0 } };
    const o = { a: { v: 1 }, b: { v: 0 } };
    const t = { a: { v: 0 }, b: { v: 2 } };
    assert.equal(stable(mergeEntry(o, t, b, root)), stable(mergeEntry(t, o, b, root)));
  });
});

describe('three-way merge — sets, logs, lists', () => {
  test('sets: additions from both kept, removal by either honoured', () => {
    assert.deepEqual(mergeSet(['a', 'b', 'x'], ['a', 'c'], ['a', 'b']).sort(), ['a', 'c', 'x']);
  });
  test('links with sub-sets merge per sub-set', () => {
    const schema = { links: ['byFile'] };
    const b = { byFile: { f1: { facts: ['a'], evidence: ['e1'] } } };
    const o = { byFile: { f1: { facts: ['a', 'b'], evidence: ['e1'] } } };
    const t = { byFile: { f1: { facts: ['a'], evidence: ['e1', 'e2'] }, f2: { facts: ['z'], evidence: [] } } };
    const r = mergeEntry(o, t, b, schema);
    assert.deepEqual(r.byFile.f1, { facts: ['a', 'b'], evidence: ['e1', 'e2'] });
    assert.deepEqual(r.byFile.f2, { facts: ['z'], evidence: [] });
  });
  test('a link removed here and untouched there is removed', () => {
    const b = { byFile: { f1: ['a'] } };
    assert.deepEqual(mergeEntry({ byFile: {} }, b, b, { links: ['byFile'] }).byFile, {});
  });
  test('logs: union by id, in time order, capped', () => {
    const schema = { logs: { ledger: { id: x => `${x.at}:${x.op}`, time: x => x.at, cap: 3 } } };
    const r = mergeEntry({ ledger: [{ at: 1, op: 'a' }, { at: 3, op: 'c' }] }, { ledger: [{ at: 1, op: 'a' }, { at: 2, op: 'b' }, { at: 4, op: 'd' }] }, undefined, schema);
    assert.deepEqual(r.ledger.map(x => x.op), ['b', 'c', 'd']);
  });
  test('root lists (attachments): by id, deletions three-way, ordered by time', () => {
    const s = { rootList: { id: x => x.id, time: x => x.uploadedAt } };
    const b = [{ id: 'a', uploadedAt: 1 }, { id: 'b', uploadedAt: 2 }];
    const o = [{ id: 'a', uploadedAt: 1 }, { id: 'c', uploadedAt: 3 }];           // removed b, added c
    const t = [{ id: 'a', uploadedAt: 1 }, { id: 'b', uploadedAt: 2 }, { id: 'd', uploadedAt: 4 }];
    assert.deepEqual(mergeEntry(o, t, b, s).map(x => x.id), ['a', 'c', 'd']);
  });
  test('plain fields: three-way on the whole value', () => {
    assert.equal(mergeEntry({ name: 'B' }, { name: 'A' }, { name: 'A' }, {}).name, 'B');
    assert.equal(mergeEntry({ name: 'A' }, { name: 'C' }, { name: 'A' }, {}).name, 'C');
  });
});
