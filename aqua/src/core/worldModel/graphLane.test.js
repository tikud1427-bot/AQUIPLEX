/**
 * graphLane — E7/PR-4 canonical graph lane
 *
 * TWO LAYERS, and the split is deliberate:
 *
 *  1. CONTRACT (always runs). A fake pool captures the SQL and parameters, so
 *     caps, owner-first binding, anchor hygiene, fail-open and the SQL's
 *     structural promises are pinned in every CI run.
 *
 *  2. TRAVERSAL (real Postgres). pg-mem cannot execute `WITH RECURSIVE`
 *     ("recursirve with statements not implemented"), so the actual walk —
 *     hop distances, cycles, fanout, lifecycle, isolation, determinism —
 *     can only be proven against a real server. Set AQUA_TEST_PG_URL to a
 *     scratch database; the test creates a private schema, applies the three
 *     migrations the edge tables need, and drops the schema afterwards.
 *     Without the variable those tests are SKIPPED and say why — a skip is
 *     reported, never a silent pass.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  traverseGraph, GRAPH_SQL, MAX_HOPS, MAX_FANOUT, MAX_ANCHORS, MAX_ENTITIES,
  DEFAULT_HOPS, DEFAULT_FANOUT, DEFAULT_ENTITIES, CURRENT_STATES, RETROSPECTIVE_STATES,
} from './graphLane.js';

const uuid = () => crypto.randomUUID();
const quiet = () => {};

function fakePool(rows = [], { fail = null } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (fail) throw new Error(fail);
      return { rows };
    },
  };
}

// ── 1. CONTRACT ───────────────────────────────────────────────────────────────

describe('graphLane — contract (no database)', () => {
  test('owner is $1 and is bound on BOTH traversal directions', () => {
    const matches = GRAPH_SQL.match(/e\.owner_id = \$1/g) ?? [];
    assert.equal(matches.length, 2, 'out-edges and in-edges must each be owner-filtered');
  });

  test('the recursive term references the walk exactly once, cycle check precedes LIMIT', () => {
    assert.equal((GRAPH_SQL.match(/FROM walk w/g) ?? []).length, 1);
    const cycle = GRAPH_SQL.indexOf('NOT (x.next_id = ANY(w.path))');
    const limit = GRAPH_SQL.indexOf('LIMIT $4::int');
    assert.ok(cycle > 0 && limit > cycle, 'a neighbour already on the path must not spend a fanout slot');
    assert.match(GRAPH_SQL, /WHERE w\.hop < \$3::int/);
    assert.match(GRAPH_SQL, /LIMIT \$8::int/);
  });

  test('hop-0 anchors are never returned', async () => {
    assert.match(GRAPH_SQL, /WHERE hop > 0/);
  });

  test('caps: callers can ask for less, never more', async () => {
    const pool = fakePool();
    await traverseGraph(pool, 'o', [uuid()], { maxHops: 99, fanout: 99, maxEntities: 99999, log: quiet });
    const [, , hops, fanout, , , , max] = pool.calls[0].params;
    assert.equal(hops, MAX_HOPS);
    assert.equal(fanout, MAX_FANOUT);
    assert.equal(max, MAX_ENTITIES);
  });

  test('defaults apply for missing, zero, negative or junk bounds', async () => {
    for (const junk of [undefined, 0, -3, 'x', NaN, null]) {
      const pool = fakePool();
      await traverseGraph(pool, 'o', [uuid()], { maxHops: junk, fanout: junk, maxEntities: junk, log: quiet });
      const [, , hops, fanout, , , , max] = pool.calls[0].params;
      assert.deepEqual([hops, fanout, max], [DEFAULT_HOPS, DEFAULT_FANOUT, DEFAULT_ENTITIES], String(junk));
    }
  });

  test('anchors: only real uuids, de-duplicated, sorted, capped — labels are refused (L8)', async () => {
    const pool = fakePool();
    const ids = Array.from({ length: 20 }, uuid);
    await traverseGraph(pool, 'o', [...ids, ids[0], 'You', 'priya', '', null, 42, "x'; DROP TABLE aqua_edges;--"], { log: quiet });
    const anchors = pool.calls[0].params[1];
    assert.equal(anchors.length, MAX_ANCHORS);
    assert.deepEqual(anchors, [...anchors].sort());
    assert.equal(new Set(anchors).size, anchors.length);
    assert.ok(anchors.every(a => /^[0-9a-f-]{36}$/.test(a)));
  });

  test('no valid anchor → no query at all, ok with a reason', async () => {
    const pool = fakePool();
    const r = await traverseGraph(pool, 'o', ['You', '', null], { log: quiet });
    assert.equal(pool.calls.length, 0);
    assert.equal(r.ok, true);
    assert.deepEqual(r.entities, []);
    assert.equal(r.reason, 'no_valid_anchor');
  });

  test('no owner → refused before any query (structural isolation, not convention)', async () => {
    const pool = fakePool();
    for (const owner of [undefined, null, '']) {
      const r = await traverseGraph(pool, owner, [uuid()], { log: quiet });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'owner_required');
    }
    assert.equal(pool.calls.length, 0);
  });

  test('present-tense walks current states with a validity instant; retrospective adds superseded and drops the window', async () => {
    const now = fakePool();
    await traverseGraph(now, 'o', [uuid()], { log: quiet });
    assert.deepEqual(now.calls[0].params[4], [...CURRENT_STATES]);
    assert.match(String(now.calls[0].params[6]), /^\d{4}-\d\d-\d\dT/);

    const past = fakePool();
    await traverseGraph(past, 'o', [uuid()], { retrospective: true, log: quiet });
    assert.deepEqual(past.calls[0].params[4], [...RETROSPECTIVE_STATES]);
    assert.equal(past.calls[0].params[6], null);

    for (const s of [CURRENT_STATES, RETROSPECTIVE_STATES]) {
      assert.ok(!s.includes('archived'), 'archived is never walked');
      assert.ok(!s.includes('extracted'), 'unreviewed machine output is not walked');
    }
    assert.ok(!CURRENT_STATES.includes('superseded'));
    assert.ok(CURRENT_STATES.includes('disputed'), 'disputed is walked and flagged, not hidden');
  });

  test('predicate filter is optional, capped at 32, blanks dropped', async () => {
    const none = fakePool();
    await traverseGraph(none, 'o', [uuid()], { log: quiet });
    assert.equal(none.calls[0].params[5], null);
    const some = fakePool();
    await traverseGraph(some, 'o', [uuid()], { predicates: ['works_with', '', 'reports_to', ...Array(50).fill('p')], log: quiet });
    assert.equal(some.calls[0].params[5].length, 32);
    assert.ok(!some.calls[0].params[5].includes(''));
  });

  test('a DB error fails OPEN: ok:false, no entities, no throw — and never invents edges', async () => {
    const r = await traverseGraph(fakePool([], { fail: 'connection reset' }), 'o', [uuid()], { log: quiet });
    assert.equal(r.ok, false);
    assert.deepEqual(r.entities, []);
    assert.match(r.reason, /^query_failed: connection reset/);
  });

  test('rows are mapped with full provenance', async () => {
    const row = {
      entity_id: uuid(), hop: '2', anchor_id: uuid(), edge_id: uuid(), claim_id: uuid(),
      predicate: 'works_with', direction: 'in', edge_state: 'disputed', path: [uuid(), uuid()],
    };
    const r = await traverseGraph(fakePool([row]), 'o', [uuid()], { log: quiet });
    assert.deepEqual(r.entities[0], {
      entityId: row.entity_id, hop: 2, anchorId: row.anchor_id, viaEdgeId: row.edge_id,
      viaClaimId: row.claim_id, predicate: 'works_with', direction: 'in', state: 'disputed', path: row.path,
    });
  });

  test('G5: one structured log line per call, carrying no owner id, entity id or label', async () => {
    const lines = [];
    const owner = 'owner-secret-123';
    const anchor = uuid();
    await traverseGraph(fakePool(), owner, [anchor], { log: l => lines.push(l) });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[GRAPH_LANE\] \{/);
    assert.ok(!lines[0].includes(owner));
    assert.ok(!lines[0].includes(anchor));
    const stats = JSON.parse(lines[0].replace('[GRAPH_LANE] ', ''));
    assert.deepEqual(Object.keys(stats).sort(),
      ['anchors', 'capped', 'fanout', 'maxEntities', 'maxHops', 'ms', 'ok', 'retrospective', 'returned'].sort());
  });

  test('read-only: the lane contains no write statement', () => {
    const src = fs.readFileSync(fileURLToPath(new URL('./graphLane.js', import.meta.url)), 'utf8');
    assert.ok(!/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b\s+(INTO|FROM|TABLE|SET)?/i.test(GRAPH_SQL));
    assert.ok(!/from\s+['"].*db\/pool\.js['"]/.test(src), 'takes an injected pool; does not import the shared one');
  });
});

// ── 2. TRAVERSAL (real Postgres) ──────────────────────────────────────────────

const PG_URL = process.env.AQUA_TEST_PG_URL;
const SKIP = PG_URL ? false
  : 'AQUA_TEST_PG_URL not set — pg-mem cannot run WITH RECURSIVE; run against a scratch Postgres to exercise the walk';

describe('graphLane — traversal (real Postgres)', { skip: SKIP }, () => {
  const MIG = path.join(path.dirname(fileURLToPath(import.meta.url)), '../db/migrations');
  const SCHEMA = `graphlane_${crypto.randomBytes(4).toString('hex')}`;
  const OWNER = 'owner-A';
  const OTHER = 'owner-B';
  let client;
  let claimA;
  let claimB;
  const E = {};   // name → entity id (owner A)
  const day = 86_400_000;

  const q = (sql, params) => client.query(sql, params);
  const pool = { query: (sql, params) => client.query(sql, params) };

  async function entity(name, owner = OWNER) {
    const id = uuid();
    await q(`INSERT INTO aqua_entities (entity_id, owner_id, type, canonical_label, normalized_label)
             VALUES ($1,$2,'person',$3,$3)`, [id, owner, name]);
    return id;
  }
  async function claim(owner, subject) {
    const id = uuid();
    await q(`INSERT INTO aqua_claims (claim_id, owner_id, subject_entity_id, predicate, object_literal,
               polarity, modality, asserted_at, state, extractor, extractor_version, actor, statement_text, statement_norm)
             VALUES ($1,$2,$3,'knows','x','asserted','fact',now(),'active','test','v1','test','s','s')`,
      [id, owner, subject]);
    return id;
  }
  async function edge(from, to, over = {}) {
    const e = { id: uuid(), owner: OWNER, predicate: 'works_with', state: 'active',
      superseded_by: null, valid_to: null, claim: claimA, updated_at: null, ...over };
    await q(`INSERT INTO aqua_edges (edge_id, owner_id, from_entity_id, to_entity_id, predicate, claim_id,
               state, superseded_by, valid_to, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10, now()))`,
      [e.id, e.owner, from, to, e.predicate, e.claim, e.state, e.superseded_by, e.valid_to, e.updated_at]);
    return e.id;
  }
  const walk = (anchors, opts = {}) => traverseGraph(pool, OWNER, anchors, { log: quiet, ...opts });
  const ids = r => r.entities.map(e => e.entityId);

  before(async () => {
    const { default: pg } = await import('pg');
    client = new pg.Client({ connectionString: PG_URL });
    await client.connect();
    await q(`CREATE SCHEMA ${SCHEMA}`);
    await q(`SET search_path TO ${SCHEMA}`);
    for (const f of ['0001_schema_info.sql', '0005_entities.sql', '0006_claims.sql', '0008_world_model.sql']) {
      await q(fs.readFileSync(path.join(MIG, f), 'utf8'));
    }

    for (const n of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'old', 'arch', 'disp', 'p', 'q', 'r']) E[n] = await entity(n);
    const bOwner = await entity('b-only', OTHER);
    claimA = await claim(OWNER, E.a);
    claimB = await claim(OTHER, bOwner);
    E.bOwner = bOwner;

    // a → b → c → d chain. NOTE: edges are walked in both directions, so any
    // edge back into `a` would make its tail a direct neighbour — cycles are
    // tested on their own triangle below, not folded into this chain.
    await edge(E.a, E.b);
    await edge(E.b, E.c);
    await edge(E.c, E.d);
    // typed branch
    await edge(E.a, E.e, { predicate: 'reports_to' });
    // reverse-only edge: f points AT a
    await edge(E.f, E.a, { claim: claimA });
    // lifecycle
    const replacement = await edge(E.a, E.g);
    await edge(E.a, E.old, { state: 'superseded', superseded_by: replacement });
    await edge(E.a, E.arch, { state: 'archived' });
    await edge(E.a, E.disp, { state: 'disputed' });
    await edge(E.a, E.h, { valid_to: new Date(Date.now() - 30 * day) });   // ended a month ago

    // a triangle p → q → r → p, for cycle handling
    await edge(E.p, E.q);
    await edge(E.q, E.r);
    await edge(E.r, E.p);

    // owner B has its own private graph
    const b2 = await entity('b2', OTHER);
    await edge(E.bOwner, b2, { owner: OTHER, claim: claimB });
  });

  after(async () => {
    try { await q(`DROP SCHEMA ${SCHEMA} CASCADE`); } finally { await client.end(); }
  });

  test('hop distances along a chain', async () => {
    const r = await walk([E.a], { maxHops: 3 });
    assert.equal(r.ok, true);
    const hop = Object.fromEntries(r.entities.map(e => [e.entityId, e.hop]));
    assert.equal(hop[E.b], 1);
    assert.equal(hop[E.c], 2);
    assert.equal(hop[E.d], 3);
    assert.ok(!(E.a in hop), 'the anchor itself is not a result');
  });

  test('a cycle terminates: the triangle returns each other node once, never the anchor', async () => {
    const r = await walk([E.p], { maxHops: 3 });
    assert.deepEqual([...ids(r)].sort(), [E.q, E.r].sort());
    assert.ok(r.entities.every(e => e.hop === 1), 'q is out-adjacent, r is in-adjacent: both one hop');
    assert.ok(!ids(r).includes(E.p));
  });

  test('maxHops is honoured: 1 hop stops at direct neighbours', async () => {
    const r = await walk([E.a], { maxHops: 1 });
    assert.ok(r.entities.every(e => e.hop === 1));
    assert.ok(!ids(r).includes(E.c) && !ids(r).includes(E.d));
  });

  test('edges are traversed in both directions and say which way they went', async () => {
    const r = await walk([E.a], { maxHops: 1 });
    const f = r.entities.find(e => e.entityId === E.f);
    const b = r.entities.find(e => e.entityId === E.b);
    assert.equal(f.direction, 'in');
    assert.equal(b.direction, 'out');
  });

  test('provenance: each result names the edge, the claim it projects, the predicate and the path', async () => {
    const r = await walk([E.a], { maxHops: 2 });
    const c = r.entities.find(e => e.entityId === E.c);
    assert.equal(c.viaClaimId, claimA);
    assert.ok(c.viaEdgeId);
    assert.equal(c.predicate, 'works_with');
    assert.deepEqual(c.path, [E.a, E.b, E.c]);
    assert.equal(c.anchorId, E.a);
  });

  test('typed hop: predicates restrict the walk', async () => {
    const r = await walk([E.a], { maxHops: 2, predicates: ['reports_to'] });
    assert.deepEqual(ids(r), [E.e]);
  });

  test('lifecycle, present tense: superseded, archived and ended edges are not walked; disputed is, flagged', async () => {
    const r = await walk([E.a], { maxHops: 1 });
    const got = new Set(ids(r));
    assert.ok(!got.has(E.old), 'superseded edge must not answer a present-tense question');
    assert.ok(!got.has(E.arch), 'archived is never walked');
    assert.ok(!got.has(E.h), 'an edge whose valid_to has passed is not current');
    assert.ok(got.has(E.g), 'the replacement edge is walked');
    assert.equal(r.entities.find(e => e.entityId === E.disp)?.state, 'disputed');
  });

  test('lifecycle, retrospective: superseded and ended edges come back; archived still never', async () => {
    const r = await walk([E.a], { maxHops: 1, retrospective: true, fanout: 12 });
    const got = new Set(ids(r));
    assert.ok(got.has(E.old));
    assert.ok(got.has(E.h));
    assert.ok(!got.has(E.arch));
    assert.equal(r.entities.find(e => e.entityId === E.old).state, 'superseded');
  });

  test('owner isolation: another owner cannot walk this graph, even holding the anchor id', async () => {
    const stolen = await traverseGraph(pool, OTHER, [E.a], { log: quiet, maxHops: 3 });
    assert.equal(stolen.ok, true);
    assert.deepEqual(stolen.entities, [], "owner B walking owner A's anchor gets nothing");
    const mine = await traverseGraph(pool, OTHER, [E.bOwner], { log: quiet });
    assert.equal(mine.entities.length, 1);
    assert.ok(!ids(mine).some(id => Object.values(E).includes(id) && id !== E.bOwner));
  });

  test('fanout cap bounds a hub, keeps the newest edges, and is deterministic', async () => {
    const hub = await entity('hub');
    const spokes = [];
    for (let i = 0; i < 20; i++) {
      const s = await entity(`s${i}`);
      spokes.push(s);
      // spoke i is i minutes newer than spoke 0
      await edge(hub, s, { updated_at: new Date(Date.now() - (20 - i) * 60_000) });
    }
    const first = await walk([hub], { maxHops: 1, fanout: 5 });
    const again = await walk([hub], { maxHops: 1, fanout: 5 });
    assert.equal(first.entities.length, 5);
    assert.deepEqual(ids(first), ids(again), 'same graph + same arguments = same rows');
    assert.deepEqual(new Set(ids(first)), new Set(spokes.slice(15)), 'the 5 newest spokes win the fanout');
  });

  test('maxEntities caps the result and reports it', async () => {
    const r = await walk([E.a], { maxHops: 3, maxEntities: 2 });
    assert.equal(r.entities.length, 2);
    assert.equal(r.stats.capped, true);
    assert.deepEqual(r.entities.map(e => e.hop), [...r.entities.map(e => e.hop)].sort(), 'nearest first');
  });

  test('no explosion: a densely connected clique stays inside the hard caps', async () => {
    const nodes = [];
    for (let i = 0; i < 24; i++) nodes.push(await entity(`k${i}`));
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) await edge(nodes[i], nodes[j]);
    }
    const t = Date.now();
    const r = await walk([nodes[0]], { maxHops: 99, fanout: 99, maxEntities: 99999 });
    assert.ok(Date.now() - t < 5_000, 'bounded traversal finishes quickly');
    assert.ok(r.entities.length <= MAX_ENTITIES);
    assert.ok(r.entities.every(e => e.hop <= MAX_HOPS));
    assert.equal(new Set(ids(r)).size, r.entities.length, 'each entity appears once, at its nearest hop');
  });

  test('two anchors are walked together and each result names the anchor it came from', async () => {
    const r = await walk([E.a, E.bOwner /* not ours */], { maxHops: 1 });
    assert.ok(r.entities.length > 0);
    assert.ok(r.entities.every(e => e.anchorId === E.a), "a foreign anchor contributes nothing under this owner");
  });
});
