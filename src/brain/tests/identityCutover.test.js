/**
 * M2 — Identity Cutover (Phase 1).
 *
 * Switches the world model's join from normalized-name matching to canonical
 * identity, behind AQUA_CANONICAL_IDS.
 *
 * THE SAFETY PROPERTY THIS FILE EXISTS TO PROVE
 * ----------------------------------------------
 * The audit's plan was: run the backfill, diff against the current join, and
 * only flip if regressions are zero. That treats the diff as a GATE.
 *
 * Keeping the string match as a fallback is stronger. Identity is asked
 * first; whatever it cannot answer still falls through to the name match. So
 * the ID join can only ADD matches — never remove one — and a regression is
 * structurally impossible rather than merely measured-as-absent. The diff
 * stops being a gate against loss and becomes a measurement of gain.
 *
 * The guarantees under test:
 *   OFF IS UNCHANGED   default behaviour is byte-identical to pre-M2.
 *   NON-REGRESSIVE     everything the string match joined, the ID path still
 *                      joins — even with an empty or stale id map.
 *   THE GAIN           the ID path joins subjects the string match cannot.
 *   FAIL-OPEN          a broken identity layer degrades to the old join.
 *   ROLLBACK           unsetting the flag restores the old join exactly.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-m2-'));

const G = await import('../../reasoning/reasoningGraph.js');
const mindStore = await import('../../mind/mindStore.js');
const idStore = await import('../identity/idStore.js');
const C = await import('../identity/canonicalId.js');
const P = await import('../worldModel/projection.js');

const O = 'user:ananya';
const deps = () => ({ graph: G, peekMind: mindStore.peekMind, canonicalIds: C });

function fileEntity(id, label, aliases = []) {
  return G.upsertNode(O, {
    id, type: 'entity', label, kind: 'derived',
    data: { entityType: 'name', aliases, resolutionConfidence: 1, fileCount: 1 },
    sourceFiles: ['uko:deck.pdf'],
  });
}

function mindNode(key, type, label, weight = 5) {
  const mind = mindStore.getMind(O);
  mind.graph.nodes[key] = { type, label, weight, createdAt: Date.now() };
  mindStore.touchMind(mind);
}

/** Did the file-side entity acquire a conversation-side counterpart? */
const joined = (entityId) => {
  const idx = P.buildWorldIndex(deps(), O);
  return Boolean(idx.byId.get(entityId)?.mindNode);
};

beforeEach(() => {
  G._resetGraphForTests();
  mindStore._clearAllForTests();
  idStore._resetIdsForTests();
  delete process.env.AQUA_CANONICAL_IDS;
});
afterEach(() => { delete process.env.AQUA_CANONICAL_IDS; });

// ── OFF is unchanged ─────────────────────────────────────────────────────────

test('OFF: the join is by normalized name, exactly as before M2', () => {
  fileEntity('ent:name:aquiplex', 'Aquiplex Inc.');
  mindNode('organization:aquiplex', 'organization', 'Aquiplex');

  assert.ok(joined('ent:name:aquiplex'), 'legal-suffix normalization still matches');
});

test('OFF: an id map is never consulted, even when populated', () => {
  fileEntity('ent:name:openai', 'OpenAI Inc.');
  mindNode('organization:open ai', 'organization', 'Open AI');
  C.resolve(O, { name: 'OpenAI Inc.', kind: 'name', ref: { space: 'reasoning', ref: 'ent:name:openai' } });
  C.resolve(O, { name: 'Open AI', kind: 'organization', ref: { space: 'mind', ref: 'organization:open ai' } });

  assert.equal(joined('ent:name:openai'), false,
    'with the flag off, a populated map must change nothing');
});

// ── NON-REGRESSIVE ───────────────────────────────────────────────────────────

test('ON with an EMPTY id map: every string-match join still holds', () => {
  fileEntity('ent:name:aquiplex', 'Aquiplex Inc.');
  mindNode('organization:aquiplex', 'organization', 'Aquiplex');
  process.env.AQUA_CANONICAL_IDS = 'on';

  assert.equal(idStore.idStats().entries, 0, 'no backfill has run');
  assert.ok(joined('ent:name:aquiplex'),
    'an un-backfilled deployment must behave exactly as it did before the flag');
});

test('ON with a PARTIAL id map: unmapped subjects fall through to the name match', () => {
  fileEntity('ent:name:aquiplex', 'Aquiplex Inc.');
  mindNode('organization:aquiplex', 'organization', 'Aquiplex');
  fileEntity('ent:name:priya', 'Priya Sharma');
  mindNode('person:priya sharma', 'person', 'Priya Sharma');

  // Only ONE subject is in the map.
  C.resolve(O, { name: 'Aquiplex Inc.', kind: 'name', ref: { space: 'reasoning', ref: 'ent:name:aquiplex' } });
  C.resolve(O, { name: 'Aquiplex', kind: 'organization', ref: { space: 'mind', ref: 'organization:aquiplex' } });

  process.env.AQUA_CANONICAL_IDS = 'on';
  assert.ok(joined('ent:name:aquiplex'), 'mapped subject joins via identity');
  assert.ok(joined('ent:name:priya'), 'unmapped subject still joins via the name match');
});

// ── THE GAIN ─────────────────────────────────────────────────────────────────

test('ON: identity joins what the string match provably cannot', () => {
  // normalizeMention("OpenAI Inc.") === "openai"; ("Open AI") === "open ai".
  // The names never match as strings; similarity resolution merges them.
  fileEntity('ent:name:openai', 'OpenAI Inc.');
  mindNode('organization:open ai', 'organization', 'Open AI');

  assert.equal(joined('ent:name:openai'), false, 'baseline: the string match misses this');

  C.resolve(O, { name: 'OpenAI Inc.', kind: 'name', ref: { space: 'reasoning', ref: 'ent:name:openai' } });
  C.resolve(O, { name: 'Open AI', kind: 'organization', ref: { space: 'mind', ref: 'organization:open ai' } });

  process.env.AQUA_CANONICAL_IDS = 'on';
  assert.ok(joined('ent:name:openai'), 'this join is the entire point of the cutover');
});

test('ON: the gained join carries the Mind\'s semantic type through', () => {
  fileEntity('ent:name:openai', 'OpenAI Inc.');
  mindNode('organization:open ai', 'organization', 'Open AI');
  C.resolve(O, { name: 'OpenAI Inc.', kind: 'name', ref: { space: 'reasoning', ref: 'ent:name:openai' } });
  C.resolve(O, { name: 'Open AI', kind: 'organization', ref: { space: 'mind', ref: 'organization:open ai' } });
  process.env.AQUA_CANONICAL_IDS = 'on';

  const e = P.projectEntity(deps(), O, 'ent:name:openai');
  assert.equal(e.type, 'organization',
    'type precedence is the payoff of federating — a gained join must deliver it too');
});

// ── FAIL-OPEN ────────────────────────────────────────────────────────────────

test('a throwing identity layer degrades to the old join instead of breaking it', () => {
  fileEntity('ent:name:aquiplex', 'Aquiplex Inc.');
  mindNode('organization:aquiplex', 'organization', 'Aquiplex');
  process.env.AQUA_CANONICAL_IDS = 'on';

  const broken = {
    graph: G, peekMind: mindStore.peekMind,
    canonicalIds: { lookup: () => { throw new Error('id store on fire'); }, refs: () => [] },
  };
  const idx = P.buildWorldIndex(broken, O);
  assert.ok(idx.byId.get('ent:name:aquiplex')?.mindNode,
    'identity is an optimization; it must never be able to break retrieval');
});

test('a missing canonicalIds dep is simply the old behaviour', () => {
  fileEntity('ent:name:aquiplex', 'Aquiplex Inc.');
  mindNode('organization:aquiplex', 'organization', 'Aquiplex');
  process.env.AQUA_CANONICAL_IDS = 'on';

  const idx = P.buildWorldIndex({ graph: G, peekMind: mindStore.peekMind }, O);
  assert.ok(idx.byId.get('ent:name:aquiplex')?.mindNode);
});

test('an id mapped to a reasoning ref that no longer exists falls back', () => {
  fileEntity('ent:name:aquiplex', 'Aquiplex Inc.');
  mindNode('organization:aquiplex', 'organization', 'Aquiplex');
  // Stale map: points at an entity that has since been removed.
  C.resolve(O, { name: 'Aquiplex', kind: 'organization', ref: { space: 'reasoning', ref: 'ent:name:DELETED' } });
  process.env.AQUA_CANONICAL_IDS = 'on';

  assert.ok(joined('ent:name:aquiplex'),
    'a stale map must not cost a join the name match would have made');
});

// ── ROLLBACK ─────────────────────────────────────────────────────────────────

test('ROLLBACK: unsetting the flag restores the previous join exactly', () => {
  fileEntity('ent:name:openai', 'OpenAI Inc.');
  mindNode('organization:open ai', 'organization', 'Open AI');
  C.resolve(O, { name: 'OpenAI Inc.', kind: 'name', ref: { space: 'reasoning', ref: 'ent:name:openai' } });
  C.resolve(O, { name: 'Open AI', kind: 'organization', ref: { space: 'mind', ref: 'organization:open ai' } });

  process.env.AQUA_CANONICAL_IDS = 'on';
  assert.ok(joined('ent:name:openai'));

  delete process.env.AQUA_CANONICAL_IDS;
  assert.equal(joined('ent:name:openai'), false,
    'rollback is a flag unset — no data migration, nothing to undo');
});

test('the id map is never written by a read, in either mode', () => {
  fileEntity('ent:name:aquiplex', 'Aquiplex Inc.');
  mindNode('organization:aquiplex', 'organization', 'Aquiplex');
  process.env.AQUA_CANONICAL_IDS = 'on';

  const before = idStore.idStats().entries;
  for (let i = 0; i < 5; i++) P.buildWorldIndex(deps(), O);
  assert.equal(idStore.idStats().entries, before,
    'projection must resolve without minting identity — that is what lookup() is for');
});
