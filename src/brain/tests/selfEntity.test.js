/**
 * Owner self-entity — the foundation for user-anchored knowledge.
 *
 * The guarantees under test:
 *   ONE PER OWNER   exactly one, idempotent, owner-scoped.
 *   ALWAYS EXISTS   independent of whether the user's name is known.
 *   STABLE IDENTITY learning a name ENRICHES it; the id, canonical form and
 *                   label never move, because references already point there.
 *   NEVER MERGES    no named person can resolve into it — structurally, by
 *                   kind, AND by carrying no identity norms at all.
 *   UNCHANGED SEMANTICS  ordinary entity resolution behaves exactly as before.
 *   FLAGGED         off by default; rollback is the flag plus one node.
 *   FAIL-OPEN       a broken graph never costs the caller.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-self-'));

const G = await import('../../reasoning/reasoningGraph.js');
const idStore = await import('../identity/idStore.js');
const C = await import('../identity/canonicalId.js');
const S = await import('../identity/selfEntity.js');

const O = 'user:ananya';
const deps = { graph: G };

beforeEach(() => {
  G._resetGraphForTests();
  idStore._resetIdsForTests();
  process.env.AQUA_SELF_ENTITY = 'on';
});
afterEach(() => { delete process.env.AQUA_SELF_ENTITY; });

// ── Existence ────────────────────────────────────────────────────────────────

test('ONE PER OWNER: created once, idempotent across repeated calls', () => {
  const a = S.ensureSelfEntity(deps, O);
  const b = S.ensureSelfEntity(deps, O);
  const c = S.ensureSelfEntity(deps, O);

  assert.equal(a.id, S.SELF_GRAPH_ID);
  assert.equal(b.id, a.id);
  assert.equal(c.id, a.id);
  assert.equal(G.nodesByType(O, 'entity').filter(n => n.data?.isSelf).length, 1);
});

test('ALWAYS EXISTS: no name is required to create it', () => {
  const self = S.ensureSelfEntity(deps, O);
  assert.equal(self.label, 'You');
  assert.deepEqual(self.data.aliases, []);
  assert.equal(self.data.entityType, 'self');
});

test('owner-scoped: each owner gets their own, and they do not leak', () => {
  S.ensureSelfEntity(deps, O);
  S.ensureSelfEntity(deps, 'user:bob');

  assert.ok(S.getSelfEntity(deps, O));
  assert.ok(S.getSelfEntity(deps, 'user:bob'));
  assert.equal(G.nodesByType('user:carol', 'entity').length, 0, 'never created for an owner who has not ingested');
});

test("provenance is honest: 'declared', not derived or observed", () => {
  const self = S.ensureSelfEntity(deps, O);
  assert.equal(self.kind, 'declared',
    'nothing inferred or extracted this node — it exists by construction');
  assert.deepEqual(self.sourceFiles, [], 'and it claims no document evidence');
});

// ── Stable identity under enrichment ─────────────────────────────────────────

test('STABLE IDENTITY: learning a name adds an alias and moves nothing', () => {
  const before = S.ensureSelfEntity(deps, O);
  const after = S.enrichSelf(deps, O, { name: 'Priya Sharma' });

  assert.equal(after.id, before.id, 'references already point here');
  assert.equal(after.label, 'You', 'the label never becomes the name');
  assert.ok(after.data.aliases.includes('Priya Sharma'));
  assert.equal(idStore.getEntry(O, S.SELF_CANONICAL_ID).canonical, 'You');
});

test('enrichment is idempotent and bounded', () => {
  S.ensureSelfEntity(deps, O);
  for (let i = 0; i < 5; i++) S.enrichSelf(deps, O, { name: 'Priya Sharma' });
  assert.equal(S.getSelfEntity(deps, O).data.aliases.length, 1, 'no duplicate aliases');

  for (let i = 0; i < 40; i++) S.enrichSelf(deps, O, { name: `Name ${i}` });
  assert.ok(S.getSelfEntity(deps, O).data.aliases.length <= 16, 'alias list is capped');
});

test('enrichment before creation is a no-op, not a crash', () => {
  assert.equal(S.enrichSelf(deps, O, { name: 'Priya' }), null);
  assert.equal(S.enrichSelf(deps, O, {}), null, 'a missing name changes nothing');
});

// ── The no-merge guarantee ───────────────────────────────────────────────────

test('NEVER MERGES: a named person does not resolve into the self entity', () => {
  S.ensureSelfEntity(deps, O);
  const priya = C.resolve(O, { name: 'Priya Sharma', kind: 'person' });

  assert.notEqual(priya.id, S.SELF_CANONICAL_ID);
  assert.ok(priya.created, 'a named person gets their own identity');
});

test('NEVER MERGES: even a wildcard mention cannot reach it', () => {
  S.ensureSelfEntity(deps, O);
  // Wildcard is the one path that scans every kind — so this is the case that
  // would break if the self entry carried identity norms.
  const any = C.resolve(O, { name: 'You', kind: 'name' });
  assert.notEqual(any.id, S.SELF_CANONICAL_ID,
    'the self entity carries no norms, so nothing resolves to it by name');
});

test('NEVER MERGES: an alias learned later stays out of the identity map', () => {
  S.ensureSelfEntity(deps, O);
  S.enrichSelf(deps, O, { name: 'Priya Sharma' });

  const lookedUp = C.lookup(O, 'Priya Sharma', 'person');
  assert.notEqual(lookedUp.id, S.SELF_CANONICAL_ID,
    'an alias in the identity map would fuse the user with anyone sharing the name');

  const entry = idStore.getEntry(O, S.SELF_CANONICAL_ID);
  assert.deepEqual(entry.norms, [], 'the self entry is reachable by id only');
});

test('the self entity IS reachable by its canonical id, for the world-model join', () => {
  S.ensureSelfEntity(deps, O);
  const refs = C.refs(O, S.SELF_CANONICAL_ID);
  assert.deepEqual(refs, [{ space: 'reasoning', ref: S.SELF_GRAPH_ID }]);
});

// ── Unchanged semantics ──────────────────────────────────────────────────────

test('UNCHANGED SEMANTICS: ordinary resolution behaves exactly as before', () => {
  S.ensureSelfEntity(deps, O);
  const a = C.resolve(O, { name: 'OpenAI', kind: 'org' });
  const b = C.resolve(O, { name: 'Open AI', kind: 'org' });
  assert.equal(a.id, b.id, 'similarity merging is untouched');

  const p = C.resolve(O, { name: 'Priya Sharma', kind: 'person' });
  const q = C.resolve(O, { name: 'Priya Patel', kind: 'person' });
  assert.notEqual(p.id, q.id, 'and so is the refusal to over-merge');
});

test("'self' folds through the kind vocabulary like any other kind", () => {
  assert.equal(C.canonicalKind('self'), 'self');
});

// ── Flag + fail-open ─────────────────────────────────────────────────────────

test('FLAGGED: off by default, so listings and world stats are unchanged', () => {
  delete process.env.AQUA_SELF_ENTITY;
  assert.equal(S.ensureSelfEntity(deps, O), null);
  assert.equal(G.nodesByType(O, 'entity').length, 0);
  assert.equal(idStore.getEntry(O, S.SELF_CANONICAL_ID), null);
});

test('FLAGGED: enrichment is inert while the flag is off', () => {
  S.ensureSelfEntity(deps, O);
  delete process.env.AQUA_SELF_ENTITY;
  assert.equal(S.enrichSelf(deps, O, { name: 'Priya' }), null);
  assert.deepEqual(S.getSelfEntity(deps, O).data.aliases, []);
});

test('FAIL-OPEN: a throwing graph never reaches the caller', () => {
  const broken = { graph: { upsertNode: () => { throw new Error('graph on fire'); } } };
  assert.doesNotThrow(() => S.ensureSelfEntity(broken, O));
  assert.equal(S.ensureSelfEntity(broken, O), null);
});

test('FAIL-OPEN: a missing graph dep is simply null', () => {
  assert.equal(S.ensureSelfEntity({}, O), null);
  assert.equal(S.getSelfEntity({}, O), null);
});
