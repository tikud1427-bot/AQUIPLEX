/**
 * Canonical identity (Phase 1) — the resolver and its sidecar.
 *
 * The guarantees under test:
 *   ONE ID        the same real thing, spelled five ways across five stores,
 *                 resolves to one id.
 *   NEVER MERGE   two different people who look similar stay two ids. A
 *                 near-miss is surfaced, never folded.
 *   WILDCARD      the file pipeline's deliberate `name` under-typing unifies
 *                 with the Mind's semantic type — that join is the whole
 *                 point of the phase.
 *   STABLE ID     an id never changes once minted, even when its kind
 *                 upgrades, because references already point at it.
 *   NO KNOWLEDGE  delete the sidecar and nothing but the map is lost.
 *   AGREEMENT     merge decisions here match entityResolver's, because the
 *                 scoring is imported rather than reimplemented.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-ids-'));
process.env.AQUA_DATA_DIR = TMP;

const S = await import('../identity/idStore.js');
const C = await import('../identity/canonicalId.js');
const ER = await import('../../reasoning/entityResolver.js');

const O = 'user:ananya';

beforeEach(() => { S._resetIdsForTests(); });

// ── ONE ID ───────────────────────────────────────────────────────────────────

test('ONE ID: the same organization spelled four ways resolves to one id', () => {
  const spellings = ['OpenAI', 'Open AI', 'OpenAI Inc.', 'openai'];
  const ids = spellings.map(s => C.resolve(O, { name: s, kind: 'org' }).id);
  assert.equal(new Set(ids).size, 1, `expected one id, got ${[...new Set(ids)].join(', ')}`);
});

test('ONE ID: legal suffix and honorific are normalized away', () => {
  const a = C.resolve(O, { name: 'Aquiplex Technologies Pvt Ltd', kind: 'org' });
  const b = C.resolve(O, { name: 'Aquiplex', kind: 'org' });
  assert.equal(a.id, b.id);

  const p = C.resolve(O, { name: 'Dr. Priya Sharma', kind: 'person' });
  const q = C.resolve(O, { name: 'Priya Sharma', kind: 'person' });
  assert.equal(p.id, q.id);
});

test('ONE ID: canonical upgrades to the fullest surface form seen', () => {
  C.resolve(O, { name: 'Priya', kind: 'person' });
  const full = C.resolve(O, { name: 'Priya Sharma', kind: 'person' });
  assert.equal(full.canonical, 'Priya Sharma', 'the fuller form wins as the display name');
});

// ── NEVER MERGE ──────────────────────────────────────────────────────────────

test('NEVER MERGE: two people sharing a first name stay two identities', () => {
  const a = C.resolve(O, { name: 'Priya Sharma', kind: 'person' });
  const b = C.resolve(O, { name: 'Priya Patel', kind: 'person' });
  assert.notEqual(a.id, b.id, 'folding these would be a far worse failure than carrying two ids');
});

test('NEVER MERGE: a near-miss is surfaced for review, not silently merged', () => {
  C.resolve(O, { name: 'Priya Sharma', kind: 'person' });
  const b = C.resolve(O, { name: 'Priya Sharman', kind: 'person' });

  if (b.ambiguous) {
    assert.ok(b.created, 'an ambiguous match still mints its own id');
    assert.ok(b.ambiguous.score < C._internals.MERGE_THRESHOLD);
    assert.ok(b.ambiguous.score >= C._internals.REVIEW_THRESHOLD);
    assert.ok(b.ambiguous.against, 'the near-miss names what it nearly matched');
  } else {
    // Either it merged (high similarity) or scored below review — both are
    // decisions entityResolver's thresholds are entitled to make. What must
    // never happen is a merge inside the review band.
    assert.ok(b.score >= C._internals.MERGE_THRESHOLD || b.score < C._internals.REVIEW_THRESHOLD,
      `score ${b.score} sits in the review band but no ambiguity was reported`);
  }
});

test('NEVER MERGE: different kinds do not collide on the same slug', () => {
  const org = C.resolve(O, { name: 'Mercury', kind: 'org' });
  const place = C.resolve(O, { name: 'Mercury', kind: 'place' });
  assert.notEqual(org.id, place.id, 'a company and a planet are not one subject');
});

// ── WILDCARD: the join this phase exists for ─────────────────────────────────

test('WILDCARD: document-side `name` and chat-side `person` land on ONE id', () => {
  // As graphBuilder writes it — the file pipeline under-types on purpose.
  const fromFile = C.resolve(O, {
    name: 'Priya Sharma', kind: 'name',
    ref: { space: 'reasoning', ref: 'ent:name:priya_sharma' },
  });
  // As the Mind writes it — conversation supplies the semantic type.
  const fromChat = C.resolve(O, {
    name: 'Priya Sharma', kind: 'person',
    ref: { space: 'mind', ref: 'person:priya sharma' },
  });

  assert.equal(fromFile.id, fromChat.id, 'this join is the entire point of Phase 1');
  assert.equal(fromChat.kind, 'person', 'the specific kind wins over the wildcard');

  const refs = C.refs(O, fromFile.id);
  assert.equal(refs.length, 2, 'one id, two stores, both reachable');
  assert.deepEqual(refs.map(r => r.space).sort(), ['mind', 'reasoning']);
});

test('WILDCARD: two different SPECIFIC kinds split rather than merge', () => {
  C.resolve(O, { name: 'Aquiplex', kind: 'person' });   // mistyped upstream
  const later = C.resolve(O, { name: 'Aquiplex', kind: 'org' });

  assert.ok(later.created, 'a specific-kind disagreement mints a second id');
  assert.equal(later.kind, 'org');

  // The resolver cannot distinguish "two subjects sharing a name" from "one
  // subject, mistyped" — they look identical. Splitting is chosen because a
  // wrong split is visible and repairable, while a wrong merge silently
  // fuses two real subjects and is close to undetectable afterwards. Same
  // reasoning as the Mercury case above; audit R3.
  assert.equal(C.lookup(O, 'Aquiplex', 'person').id, C._internals.mintId('person', 'Aquiplex'));
});

test('WILDCARD: a wildcard entry upgrades in place, never splits', () => {
  const first = C.resolve(O, { name: 'Aquiplex', kind: 'name' });
  const second = C.resolve(O, { name: 'Aquiplex', kind: 'org' });

  assert.equal(second.id, first.id, 'under-typing must not cost an identity');
  assert.equal(second.kind, 'org');

  // And the upgraded entry is no longer reachable under the old wildcard
  // kind — a stale index key would leave two routes to one subject.
  const third = C.resolve(O, { name: 'Aquiplex', kind: 'org' });
  assert.equal(third.id, first.id);
  assert.equal(S.allEntries(O).size, 1, 'one subject, one entry');
});

test('KIND VOCABULARY: five spaces fold into one', () => {
  assert.equal(C.canonicalKind('organization'), 'org');
  assert.equal(C.canonicalKind('company'), 'org');
  assert.equal(C.canonicalKind('Organization'), 'org');
  assert.equal(C.canonicalKind('workspace'), 'project');
  assert.equal(C.canonicalKind('uko'), 'document');
  assert.equal(C.canonicalKind('something_new'), 'something_new', 'open vocabulary passes through');
});

// ── STABLE ID ────────────────────────────────────────────────────────────────

test('STABLE ID: the id does not change when the kind upgrades', () => {
  const first = C.resolve(O, { name: 'AQUA', kind: 'name' });
  assert.match(first.id, /^aq:name:/);

  const second = C.resolve(O, { name: 'AQUA', kind: 'project' });
  assert.equal(second.id, first.id, 'references already point here — the id must never move');
  assert.equal(second.kind, 'project', 'the kind FIELD is authoritative, not the id segment');
});

// ── LOOKUP vs CREATE ─────────────────────────────────────────────────────────

test('LOOKUP: read paths can resolve without minting identity', () => {
  const miss = C.lookup(O, 'Nobody', 'person');
  assert.equal(miss.id, null);
  assert.equal(S.idStats().entries, 0, 'a lookup must never create an entry');

  C.resolve(O, { name: 'Priya', kind: 'person' });
  const hit = C.lookup(O, 'Priya', 'person');
  assert.ok(hit.id);
});

// ── AGREEMENT with entityResolver ────────────────────────────────────────────

test('AGREEMENT: this resolver merges exactly where entityResolver does', () => {
  const pairs = [
    ['OpenAI', 'Open AI'],
    ['Aquiplex Inc.', 'Aquiplex'],
    ['Priya Sharma', 'Priya Patel'],
    ['AQUA', 'Aqua Engine'],
  ];

  for (const [a, b] of pairs) {
    // Batch path: what file ingest would decide.
    const batch = ER.resolveEntities([
      { value: a, type: 'name', fileId: 'f1' },
      { value: b, type: 'name', fileId: 'f2' },
    ]);
    const batchMerged = batch.entities.length === 1;

    // Incremental path: what this file decides.
    S._resetIdsForTests();
    const ra = C.resolve(O, { name: a, kind: 'name' });
    const rb = C.resolve(O, { name: b, kind: 'name' });
    const incMerged = ra.id === rb.id;

    assert.equal(incMerged, batchMerged,
      `disagreement on "${a}" vs "${b}": batch=${batchMerged} incremental=${incMerged}`);
  }
});

// ── SIDECAR CONTRACT ─────────────────────────────────────────────────────────

test('NO KNOWLEDGE: the sidecar holds a map, never a record', () => {
  const r = C.resolve(O, {
    name: 'Priya Sharma', kind: 'person',
    ref: { space: 'reasoning', ref: 'ent:name:priya_sharma' },
  });
  const entry = S.getEntry(O, r.id);

  assert.deepEqual(Object.keys(entry).sort(),
    ['canonical', 'createdAt', 'kind', 'norms', 'refs', 'updatedAt'],
    'no facts, no beliefs, no relationships — only identity and pointers');
});

test('REVERSIBLE: clearing the sidecar loses only the map', () => {
  const r = C.resolve(O, { name: 'Priya', kind: 'person', ref: { space: 'mind', ref: 'person:priya' } });
  assert.ok(S.getEntry(O, r.id));

  S._resetIdsForTests();
  assert.equal(S.getEntry(O, r.id), null);
  assert.equal(S.idStats().entries, 0);

  // Re-resolving rebuilds the same id deterministically — which is why the
  // backfill is safe to re-run and the file is safe to delete.
  const again = C.resolve(O, { name: 'Priya', kind: 'person' });
  assert.equal(again.id, r.id, 'ids are derived, not sequential — regeneration is idempotent');
});

test('PURGE: erasure removes an owner completely and leaves others intact', () => {
  C.resolve(O, { name: 'Priya', kind: 'person' });
  C.resolve('user:bob', { name: 'Sam', kind: 'person' });

  const removed = S.purgeOwner(O);
  assert.equal(removed, 1);
  assert.equal(S.allEntries(O).size, 0);
  assert.equal(S.allEntries('user:bob').size, 1, 'purge is owner-scoped');
});

test('ISOLATION: identity never leaks across owners', () => {
  const mine = C.resolve(O, { name: 'Priya Sharma', kind: 'person' });
  const theirs = C.lookup('user:bob', 'Priya Sharma', 'person');
  assert.equal(theirs.id, null, 'bob resolving the same name must not reach ananya\'s identity');
  assert.ok(mine.id);
});

test('BOUNDED: refs and norms are capped, and duplicates never accumulate', () => {
  const r = C.resolve(O, { name: 'AQUA', kind: 'project', ref: { space: 'mind', ref: 'project:aqua' } });
  for (let i = 0; i < 5; i++) C.link(O, r.id, { space: 'mind', ref: 'project:aqua' });
  assert.equal(C.refs(O, r.id).length, 1, 'linking the same ref repeatedly is idempotent');

  for (let i = 0; i < 100; i++) C.link(O, r.id, { space: 'reasoning', ref: `ent:name:x${i}` });
  assert.ok(C.refs(O, r.id).length <= 64, 'ref list is bounded');
});
