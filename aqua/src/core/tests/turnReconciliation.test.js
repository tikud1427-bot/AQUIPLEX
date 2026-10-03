/**
 * E10 — the number the heuristic-lane decision was waiting on.
 *
 * Pure counting over rows already read. The expensive mistake here would be a
 * report that silently measures a join which never matches (two copies of the
 * source-id recipe drifting), so the identity recipe is pinned to ONE definition
 * and the report is exercised against ids produced by the real writer.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalTurnSourceId, parseLegacyFactTurn, parseLegacySourceTurn } from '../worldModel/turnSourceIdentity.js';
import { reconcileTurns, totalReconciliation, verdict } from '../worldModel/turnReconciliation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const fact = (c, t, i = 0) => ({ id: `conv:${c}:${t}:fact:${i}` });
const OWNER = 'u1';

describe('turn identity', () => {
  test('parses fact ids and source ids; the turn is anchored from the RIGHT (conversation ids may hold colons)', () => {
    assert.deepEqual(parseLegacyFactTurn('conv:abc:7:fact:2'), { conversationId: 'abc', turn: 7 });
    assert.deepEqual(parseLegacyFactTurn('conv:ws:thread:9:fact:0'), { conversationId: 'ws:thread', turn: 9 });
    assert.deepEqual(parseLegacySourceTurn('conv:abc:7'), { conversationId: 'abc', turn: 7 });
  });
  test('anything that is not a conversation turn is null — never guessed', () => {
    for (const id of ['doc:1:fact:0', 'conv:abc', 'conv:abc:x:fact:1', '', null, undefined, 'fact:conv:a:1', 'conv:a:1:fact:']) {
      assert.equal(parseLegacyFactTurn(id), null, String(id));
    }
    assert.equal(parseLegacySourceTurn('conv:abc:7:fact:2'), null, 'a fact id is not a source id');
    assert.equal(parseLegacySourceTurn('conv:abc'), null);
  });
  test('a turn with no usable number and no conversation id still gets ONE stable id (the writer\'s fallback)', () => {
    const none = canonicalTurnSourceId('u1', undefined, undefined);
    assert.equal(none, canonicalTurnSourceId('u1', null, 'not-a-number'), 'every unusable turn/conversation collapses to the same fallback');
    assert.equal(none, canonicalTurnSourceId('u1', 'unknown', 'unknown'));
    assert.notEqual(none, canonicalTurnSourceId('u1', 'unknown', 0), 'turn 0 is a real turn, not the fallback');
    assert.notEqual(canonicalTurnSourceId('u1', 'c', 1.5), canonicalTurnSourceId('u1', 'c', 1), 'a non-integer turn must not alias an integer one');
  });
  test('the source id is deterministic, owner- and turn-scoped', () => {
    const a = canonicalTurnSourceId('u1', 'c', 1);
    assert.equal(a, canonicalTurnSourceId('u1', 'c', 1));
    assert.notEqual(a, canonicalTurnSourceId('u2', 'c', 1));
    assert.notEqual(a, canonicalTurnSourceId('u1', 'c', 2));
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  test('ONE recipe: the writer holds no private copy of it', () => {
    const facade = strip(fs.readFileSync(path.join(ROOT, 'src/brain/index.js'), 'utf8'));
    assert.match(facade, /canonicalTurnSourceId\(ownerId, conversationId, turn\)/);
    assert.doesNotMatch(facade, /conversation-turn:/, 'the facade rebuilt the recipe itself');
    assert.doesNotMatch(facade, /function deterministicUuid/);
  });
});

describe('reconcileTurns', () => {
  const sid = (c, t) => canonicalTurnSourceId(OWNER, c, t);

  test('splits turns into both / legacy-only / canonical-only', () => {
    const legacy = [fact('c', 0), fact('c', 0, 1), fact('c', 1), fact('c', 2)];
    const canon = new Map([[sid('c', 0), 3], [sid('c', 2), 0], [sid('c', 9), 2]]);
    const r = reconcileTurns(OWNER, legacy, canon);
    assert.deepEqual(r.legacy, { turns: 3, facts: 4, unjoinable: 0 });
    assert.deepEqual(r.both, { turns: 1, legacyFacts: 2, claims: 3 });
    assert.equal(r.legacyOnly.turns, 2);                 // turn 1 (no source) and turn 2 (source, zero claims)
    assert.deepEqual(r.legacyOnly.sample.sort(), ['c:1', 'c:2']);
    assert.deepEqual(r.canonicalOnly, { turns: 1, claims: 2 });
  });

  test('a canonical SOURCE with zero claims is not coverage', () => {
    const r = reconcileTurns(OWNER, [fact('c', 0)], new Map([[sid('c', 0), 0]]));
    assert.equal(r.both.turns, 0);
    assert.equal(r.legacyOnly.turns, 1);
    assert.equal(r.canonical.turns, 0);
  });

  test('an EMPTY canonical source is not a canonical-only turn either', () => {
    const r = reconcileTurns(OWNER, [], new Map([[sid('c', 5), 0], [sid('c', 6), 2]]));
    assert.deepEqual(r.canonicalOnly, { turns: 1, claims: 2 }, 'a source with zero claims was counted as coverage');
  });

  test('unjoinable legacy facts are reported, never matched', () => {
    const r = reconcileTurns(OWNER, [{ id: 'doc:9:fact:0' }, fact('c', 0)], new Map());
    assert.equal(r.legacy.unjoinable, 1);
    assert.equal(r.legacy.turns, 1);
  });

  test('turns of another owner do not match: the join key includes the owner', () => {
    const other = new Map([[canonicalTurnSourceId('someone-else', 'c', 0), 4]]);
    const r = reconcileTurns(OWNER, [fact('c', 0)], other);
    assert.equal(r.both.turns, 0);
    assert.equal(r.legacyOnly.turns, 1);
  });

  test('accepts a plain object as well as a Map; empty input is all zeros', () => {
    assert.equal(reconcileTurns(OWNER, [fact('c', 0)], { [sid('c', 0)]: 1 }).both.turns, 1);
    const z = reconcileTurns(OWNER, [], undefined);
    assert.deepEqual([z.legacy.turns, z.both.turns, z.legacyOnly.turns, z.canonicalOnly.turns], [0, 0, 0, 0]);
  });

  test('totals add up across owners', () => {
    const a = reconcileTurns('a', [fact('c', 0)], new Map());
    const b = reconcileTurns('b', [fact('c', 0), fact('c', 1)], new Map([[canonicalTurnSourceId('b', 'c', 0), 1]]));
    const t = totalReconciliation([a, b]);
    assert.equal(t.owners, 2);
    assert.equal(t.legacy.turns, 3);
    assert.equal(t.both.turns, 1);
    assert.equal(t.legacyOnly.turns, 2);
  });
});

describe('verdict — a sentence about what the numbers allow, never an action', () => {
  const total = (o) => totalReconciliation([reconcileTurns(OWNER, o.legacy, o.canon)]);
  test('no canonical coverage at all says the E6 lane is not committing, and not to switch anything off', () => {
    const v = verdict(total({ legacy: [fact('c', 0)], canon: new Map() }));
    assert.match(v, /NO claims/); assert.match(v, /do not switch/);
  });
  test('partial coverage quantifies what switching the heuristic lane off would drop', () => {
    const v = verdict(total({ legacy: [fact('c', 0), fact('c', 1)], canon: new Map([[canonicalTurnSourceId(OWNER, 'c', 0), 1]]) }));
    assert.match(v, /1 of 2 legacy turn\(s\) \(50%\)/); assert.match(v, /ONLY in the legacy store/);
  });
  test('full coverage says the heuristic lane adds none', () => {
    const v = verdict(total({ legacy: [fact('c', 0)], canon: new Map([[canonicalTurnSourceId(OWNER, 'c', 0), 1]]) }));
    assert.match(v, /adds no turn coverage/);
  });
  test('empty legacy store', () => {
    assert.match(verdict(total({ legacy: [], canon: new Map() })), /nothing depends on it/);
  });
});

describe('the CLI is read-only', () => {
  const src = strip(fs.readFileSync(path.join(ROOT, 'scripts/e10-reconcile.mjs'), 'utf8'));
  test('no write SQL and no write to the legacy file', () => {
    assert.doesNotMatch(src, /\b(INSERT\s+INTO|UPDATE\s+aqua_|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|DROP\s)/i);
    assert.doesNotMatch(src, /writeFile|appendFile|createWriteStream|unlink|rmSync|renameSync/);
    assert.match(src, /readFileSync/);
  });
  test('it never imports the engine (an import would start ingest side effects)', () => {
    assert.doesNotMatch(src, /brain\/index\.js|evidenceStore|router\.js/);
  });
});
