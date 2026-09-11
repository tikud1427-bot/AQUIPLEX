/**
 * E6/PR-10 — the S9 commit plan.
 *
 * Two properties carry the weight:
 *
 *   1. RE-INGEST IS A NO-OP AND AN UPGRADE IS NOT. Those are the two halves of
 *      S9's promise and they pull in opposite directions — the key has to
 *      collide on one and diverge on the other.
 *   2. NOTHING VANISHES QUIETLY. Four of nine write targets have no migration.
 *      A plan that omitted them would make S9 look finished while edges and
 *      events silently never landed.
 *
 * Run: node --test src/brain/tests/commitPlan.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCommitPlan, idempotencyKey, COMMIT_ORDER, WRITABLE_TARGETS, PENDING_TARGETS,
} from '../understanding/commitPlan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(HERE, '..', '..', 'core', 'db', 'migrations');

const base = (over = {}) => ({
  sourceId: 'src-1',
  segmentRange: [0, 22],
  extractorVersion: 'v1',
  claims: [{ claimId: 'c1', subject: 'self', predicate: 'works_at',
    objectKind: 'entity', object: { entity: 'Nummo' }, evidence: ['e1'] }],
  ...over,
});

describe('S9 — the idempotency key is exactly (source, range, version)', () => {
  test('the same segment and version produce the same key', () => {
    assert.equal(idempotencyKey(base()), idempotencyKey(base()));
  });

  test('RE-INGEST IS A NO-OP', () => {
    const key = idempotencyKey(base());
    const plan = buildCommitPlan(base({ committedKeys: new Set([key]) }));
    assert.equal(plan.committed, true);
    assert.deepEqual(plan.operations, []);
    assert.equal(plan.stats.skipped, 'already-committed');
  });

  test('"already committed" is distinguishable from "nothing to do"', () => {
    // Both write zero rows. A caller that cannot tell them apart will retry
    // one of them forever or skip the other silently.
    const already = buildCommitPlan(base({ committedKeys: new Set([idempotencyKey(base())]) }));
    const empty = buildCommitPlan({ sourceId: 's', segmentRange: [0, 1], extractorVersion: 'v1' });
    assert.equal(already.committed, true);
    assert.equal(empty.committed, false);
    assert.equal(empty.stats.skipped, undefined);
  });

  test('AN EXTRACTOR UPGRADE RE-RUNS CLEANLY — the other half of the promise', () => {
    // The key must COLLIDE on re-ingest and DIVERGE on upgrade. A key that
    // only did the first would freeze the store at v1 forever.
    const v1Key = idempotencyKey(base({ extractorVersion: 'v1' }));
    const plan = buildCommitPlan(base({ extractorVersion: 'v2', committedKeys: new Set([v1Key]) }));
    assert.equal(plan.committed, false, 'v2 must not be skipped because v1 ran');
    assert.ok(plan.operations.length > 0);
  });

  test('a different segment of the SAME source is a different key', () => {
    assert.notEqual(
      idempotencyKey(base({ segmentRange: [0, 22] })),
      idempotencyKey(base({ segmentRange: [23, 46] })));
  });

  test('a different source is a different key', () => {
    assert.notEqual(idempotencyKey(base()), idempotencyKey(base({ sourceId: 'src-2' })));
  });

  test('array and object range shapes hash ALIKE', () => {
    // Two shapes of the same range producing two keys would double-commit
    // exactly the work the key exists to deduplicate.
    assert.equal(
      idempotencyKey(base({ segmentRange: [0, 22] })),
      idempotencyKey(base({ segmentRange: { start: 0, end: 22 } })));
  });

  test('fields cannot run together to collide', () => {
    // Without a separator ("ab","c") and ("a","bc") hash identically, and one
    // segment's understanding is served for another's.
    assert.notEqual(
      idempotencyKey({ sourceId: 'ab', segmentRange: 'c', extractorVersion: 'v' }),
      idempotencyKey({ sourceId: 'a', segmentRange: 'bc', extractorVersion: 'v' }));
  });
});

describe('S9 — nothing vanishes quietly', () => {
  test('all nine targets remain explicit and writable', () => {
    const plan = buildCommitPlan(base({
      edges: [{ from: 'self', to: 'Nummo', type: 'works_at' }],
      events: [{ kind: 'joined' }],
    }));
    const targets = plan.operations.map(o => o.target);
    assert.ok(targets.includes('edges'), 'edges appear in the plan');
    assert.ok(targets.includes('lifecycle_transitions'));
    assert.ok(targets.includes('outbox'));

    assert.equal(plan.stats.blocked, 0);
    assert.deepEqual(plan.stats.blockedTargets, []);
  });

  test('blocked rows are counted SEPARATELY from total rows', () => {
    // A plan reporting healthy totals while a third of it cannot land is the
    // failure this stat exists to prevent.
    const plan = buildCommitPlan(base({ edges: [{ from: 'a', to: 'b', type: 'knows' }] }));
    assert.equal(plan.stats.blocked, 0);
    assert.equal(plan.stats.blockedTargets.length, 0);
  });

  test('atomicPossible is TRUE when every target has schema support', () => {
    // S9 says "single transaction". It cannot be one until every target
    // exists, and claiming otherwise would be the whole point missed.
    assert.equal(buildCommitPlan(base()).stats.atomicPossible, true);
  });

  // LOGICAL → PHYSICAL lives here, not in the module. The plan names logical
  // targets so it stays substrate-agnostic and so the "one writer touches the
  // claim tables" guard keeps its full meaning; the mapping is a test concern
  // because only the test needs to know whether a migration has landed.
  const PHYSICAL = Object.freeze({
    sources: 'aqua_sources', evidence: 'aqua_evidence', entities: 'aqua_entities',
    aliases: 'aqua_entity_aliases', claims: 'aqua_claims', claim_evidence: 'aqua_claim_evidence',
    edges: 'aqua_edges', events: 'aqua_events',
    lifecycle_transitions: 'aqua_lifecycle_transitions', outbox: 'aqua_outbox',
  });

  test('every logical target has a physical mapping', () => {
    // Without this, a new target added to COMMIT_ORDER would silently have no
    // mapping and the migration check below would skip it — passing by
    // omission, which is how a blocked target comes to look writable.
    for (const t of COMMIT_ORDER) {
      assert.ok(PHYSICAL[t], `${t} has no physical mapping`);
    }
  });

  test('the writable/pending split matches the migrations ON DISK', () => {
    // Read from the filesystem, not from a hand-kept list — the two would
    // drift the first time a migration lands, and the plan would keep
    // reporting `edges` as blocked after it became writable.
    const sql = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql'))
      .map(f => readFileSync(path.join(MIGRATIONS, f), 'utf8')).join('\n');
    const exists = t => new RegExp(`CREATE TABLE IF NOT EXISTS ${PHYSICAL[t]}\\b`).test(sql);

    for (const t of WRITABLE_TARGETS) {
      assert.ok(exists(t), `${t} (${PHYSICAL[t]}) is listed writable but has no migration`);
    }
    for (const t of PENDING_TARGETS) {
      assert.ok(!exists(t),
        `${t} now HAS a migration — move it to WRITABLE_TARGETS and re-check atomicPossible`);
    }
  });
});

describe('S9 — dependency order, because foreign keys decide it', () => {
  test('entities and evidence precede claims; claims precede edges', () => {
    // Write an edge before its claim and the FK rejects it, inside a
    // transaction that then rolls back everything — one ordering mistake
    // discards a whole turn's understanding.
    const i = t => COMMIT_ORDER.indexOf(t);
    assert.ok(i('entities') < i('claims'));
    assert.ok(i('evidence') < i('claims'));
    assert.ok(i('claims') < i('claim_evidence'));
    assert.ok(i('claims') < i('edges'));
    assert.ok(i('claims') < i('lifecycle_transitions'));
    assert.ok(i('outbox') === COMMIT_ORDER.length - 1, 'the event fires last');
  });

  test('the plan is emitted in COMMIT_ORDER', () => {
    const plan = buildCommitPlan(base({ edges: [{ from: 'a', to: 'b' }], events: [{ kind: 'x' }] }));
    const order = plan.operations.map(o => COMMIT_ORDER.indexOf(o.target));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  });

  test('empty targets are omitted rather than planned as no-ops', () => {
    const plan = buildCommitPlan(base({ edges: [], events: [] }));
    assert.equal(plan.operations.some(o => o.target === 'edges'), false);
  });
});

describe('S9 — a claim never lands without the rows its keys need', () => {
  test('entities are derived from the claims, not taken on trust', () => {
    const plan = buildCommitPlan(base());
    const ents = plan.operations.find(o => o.target === 'entities');
    const names = ents.rows.map(r => r.name).sort();
    assert.deepEqual(names, ['Nummo', 'self'], 'both subject and entity-object');
  });

  test('a literal object does NOT become an entity', () => {
    const plan = buildCommitPlan(base({
      claims: [{ claimId: 'c1', subject: 'self', predicate: 'uses',
        objectKind: 'literal', object: { literal: 'Postgres' }, evidence: [] }],
    }));
    const ents = plan.operations.find(o => o.target === 'entities');
    assert.deepEqual(ents.rows.map(r => r.name), ['self'],
      'an edge to an unresolved string is a node nothing can reach');
  });

  test('evidence and the claim_evidence bridge are both planned', () => {
    const plan = buildCommitPlan(base());
    assert.equal(plan.operations.find(o => o.target === 'evidence').count, 1);
    assert.equal(plan.operations.find(o => o.target === 'claim_evidence').count, 1);
  });

  test('lifecycle records extracted → active for every claim', () => {
    const plan = buildCommitPlan(base());
    const lc = plan.operations.find(o => o.target === 'lifecycle_transitions');
    assert.deepEqual(lc.rows[0].from, 'extracted');
    assert.deepEqual(lc.rows[0].to, 'active');
  });
});

describe('S9 — contradictions are OUTBOX EVENTS, never claim mutations', () => {
  test('a contradiction emits an event and changes no claim', () => {
    // S8 emits and refuses to decide. If S9 wrote a resolution it would undo
    // that restraint one stage later and the surviving claim would look
    // undisputed.
    const plan = buildCommitPlan(base({
      contradictions: [{ subject: 'self', predicate: 'works_at', kind: 'polarity' }],
    }));
    const outbox = plan.operations.find(o => o.target === 'outbox');
    assert.ok(outbox.rows.some(r => r.type === 'ContradictionDetected'));
    assert.equal(plan.operations.find(o => o.target === 'claims').count, 1,
      'the claim count is unchanged by the contradiction');
    assert.equal(plan.stats.contradictions, 1);
  });

  test('nothing in the plan resolves anything', () => {
    const plan = buildCommitPlan(base({
      contradictions: [{ subject: 'self', predicate: 'works_at', kind: 'polarity' }],
    }));
    for (const k of ['resolved', 'winner', 'survivor', 'supersede']) {
      assert.equal(k in plan, false, `S9 must not expose ${k}`);
    }
  });
});

describe('S9 — the plan executes nothing', () => {
  test('the module opens no connection and builds no SQL', () => {
    // The point of a plan is that it is inspectable before anything is
    // irreversible. A module that could half-apply would make the audit
    // pointless.
    const src = readFileSync(path.join(HERE, '..', 'understanding', 'commitPlan.js'), 'utf8');
    const code = src.split('\n').filter(l => !l.trimStart().startsWith('*')).join('\n');
    // Checked as CALLS and SQL keywords, not bare substrings — the first
    // version of this test failed on `COMMIT_ORDER`, which is the module's own
    // constant. A guard that fires on its own vocabulary gets deleted rather
    // than fixed, and then guards nothing.
    for (const forbidden of [/\bgetPool\s*\(/, /\bclient\.query\s*\(/, /INSERT\s+INTO/i,
      /query\(\s*['"`]BEGIN/i, /query\(\s*['"`]COMMIT/i]) {
      assert.ok(!forbidden.test(code), `commitPlan must not contain ${forbidden}`);
    }
  });

  test('degenerate input does not throw', () => {
    for (const bad of [undefined, {}, { claims: null }, { claims: 'x' }]) {
      const plan = buildCommitPlan(bad);
      assert.equal(typeof plan.key, 'string');
      assert.ok(Array.isArray(plan.operations));
    }
  });
});
