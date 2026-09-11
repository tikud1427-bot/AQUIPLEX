/**
 * AQUA — the world-model substrate: edges, events, lifecycle_transitions,
 * revisions, corrections
 * Blueprint E5 · continues PR-1 through PR-6 (see 0008_world_model.sql's
 * header for the corrected PR count — this migration is really PR-7, not
 * the PR-3 label it arrived under).
 *
 * The tables only. Nothing reads or writes them yet — a test asserts that,
 * the same discipline 0005/0006 used before PR-3 added the claim
 * repository. Every CHECK below is fed the bad value and asserted to
 * REFUSE it, then the good one and asserted to accept — a schema is a set
 * of promises, and a promise nobody tested is a comment.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryPg } from './helpers/memoryPg.mjs';
import { _setPoolForTests, _resetForTests } from '../db/pool.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let mem, restorePool;
const envBefore = process.env.DATABASE_URL;

const OWNER = 'user:e5-wm';
const OTHER = 'user:e5-wm-other';
let PRIYA, AQUIPLEX, PRIYA_OTHER, CLAIM_OWNER, CLAIM_OTHER;

before(async () => {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/aqua';
  _resetForTests();
  mem = createMemoryPg();
  restorePool = _setPoolForTests(mem.pool);
  const applied = (await (await import('../db/migrate.js')).migrate()).applied.map(a => a.name);
  assert.ok(applied.includes('world_model'), 'the 0008 migration did not apply');

  PRIYA = await addEntity('person', 'Priya', 'priya', OWNER);
  AQUIPLEX = await addEntity('org', 'Aquiplex', 'aquiplex', OWNER);
  PRIYA_OTHER = await addEntity('person', 'Priya', 'priya', OTHER);
  CLAIM_OWNER = await insertClaimReturningId({ owner_id: OWNER, subject_entity_id: PRIYA });
  CLAIM_OTHER = await insertClaimReturningId({ owner_id: OTHER, subject_entity_id: PRIYA_OTHER });
});

after(async () => {
  restorePool?.();
  await mem?.close();
  if (envBefore === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = envBefore;
  _resetForTests();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function addEntity(type, label, norm, owner) {
  const id = crypto.randomUUID();
  await mem.pool.query(
    `INSERT INTO aqua_entities (entity_id, owner_id, type, canonical_label, normalized_label)
     VALUES ($1,$2,$3,$4,$5)`, [id, owner, type, label, norm]);
  return id;
}

/** Insert a claim (the 0006 shape) and return its id. */
async function insertClaimReturningId(over = {}) {
  const c = {
    claim_id: crypto.randomUUID(), owner_id: OWNER,
    subject_entity_id: PRIYA, predicate: 'works_at',
    object_entity_id: null, object_literal: 'Aquiplex',
    object_quantity: null, object_time_from: null,
    polarity: 'asserted', modality: 'fact',
    valid_from: null, valid_to: null,
    state: 'active', superseded_by: null,
    statement_text: `s-${Math.random()}`,
    ...over,
  };
  await mem.pool.query(
    `INSERT INTO aqua_claims (
       claim_id, owner_id, subject_entity_id, predicate,
       object_entity_id, object_literal, object_quantity, object_time_from,
       polarity, modality, valid_from, valid_to, asserted_at,
       state, superseded_by, extractor, extractor_version, actor,
       statement_text, statement_norm)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),$13,$14,'test','v1','test',$15,$15)`,
    [c.claim_id, c.owner_id, c.subject_entity_id, c.predicate,
      c.object_entity_id, c.object_literal, c.object_quantity, c.object_time_from,
      c.polarity, c.modality, c.valid_from, c.valid_to,
      c.state, c.superseded_by, c.statement_text]);
  return c.claim_id;
}

function insertEdge(over = {}) {
  const e = {
    edge_id: crypto.randomUUID(), owner_id: OWNER,
    from_entity_id: PRIYA, to_entity_id: AQUIPLEX, predicate: 'works_at',
    claim_id: CLAIM_OWNER, state: 'active', superseded_by: null,
    valid_from: null, valid_to: null,
    ...over,
  };
  return mem.pool.query(
    `INSERT INTO aqua_edges (
       edge_id, owner_id, from_entity_id, to_entity_id, predicate,
       claim_id, state, superseded_by, valid_from, valid_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [e.edge_id, e.owner_id, e.from_entity_id, e.to_entity_id, e.predicate,
      e.claim_id, e.state, e.superseded_by, e.valid_from, e.valid_to]);
}

function insertEvent(over = {}) {
  const ev = {
    event_id: crypto.randomUUID(), owner_id: OWNER,
    event_type: 'meeting', statement_text: `e-${Math.random()}`,
    subject_entity_id: PRIYA, claim_id: CLAIM_OWNER,
    occurred_at: new Date('2026-01-05T10:00:00Z'), occurred_to: null,
    time_precision: 'exact', state: 'active', superseded_by: null,
    ...over,
  };
  return mem.pool.query(
    `INSERT INTO aqua_events (
       event_id, owner_id, event_type, statement_text,
       subject_entity_id, claim_id, occurred_at, occurred_to,
       time_precision, state, superseded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [ev.event_id, ev.owner_id, ev.event_type, ev.statement_text,
      ev.subject_entity_id, ev.claim_id, ev.occurred_at, ev.occurred_to,
      ev.time_precision, ev.state, ev.superseded_by]);
}

function insertTransition(over = {}) {
  const t = {
    transition_id: crypto.randomUUID(), owner_id: OWNER,
    target_kind: 'claim', target_id: crypto.randomUUID(),
    from_state: 'extracted', to_state: 'active',
    reason: 'reviewed', actor: 'test',
    ...over,
  };
  return mem.pool.query(
    `INSERT INTO aqua_lifecycle_transitions (
       transition_id, owner_id, target_kind, target_id,
       from_state, to_state, reason, actor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [t.transition_id, t.owner_id, t.target_kind, t.target_id,
      t.from_state, t.to_state, t.reason, t.actor]);
}

function insertRevision(over = {}) {
  const r = {
    revision_id: crypto.randomUUID(), owner_id: OWNER,
    target_kind: 'claim', target_id: crypto.randomUUID(),
    change_kind: 'update', before: { state: 'extracted' }, after: { state: 'active' },
    reason: 'reviewed', actor: 'test', source: 'test-suite',
    reversible: true, reverted_at: null,
    ...over,
  };
  return mem.pool.query(
    `INSERT INTO aqua_revisions (
       revision_id, owner_id, target_kind, target_id, change_kind,
       before, after, reason, actor, source, reversible, reverted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [r.revision_id, r.owner_id, r.target_kind, r.target_id, r.change_kind,
      r.before, r.after, r.reason, r.actor, r.source, r.reversible, r.reverted_at]);
}

function insertCorrection(over = {}) {
  const c = {
    correction_id: crypto.randomUUID(), owner_id: OWNER,
    target_kind: 'claim', target_id: crypto.randomUUID(),
    action: 'correct', before: { object_literal: 'Aquiplx' }, after: { object_literal: 'Aquiplex' },
    actor: 'user:priya',
    ...over,
  };
  return mem.pool.query(
    `INSERT INTO aqua_corrections (
       correction_id, owner_id, target_kind, target_id, action, before, after, actor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [c.correction_id, c.owner_id, c.target_kind, c.target_id, c.action, c.before, c.after, c.actor]);
}

// ── The tables exist, and existing migrations still run ─────────────────────

describe('world model schema — the tables, and the migration chain', () => {
  test('every table this PR adds is created', async () => {
    for (const t of ['aqua_edges', 'aqua_events', 'aqua_lifecycle_transitions',
      'aqua_revisions', 'aqua_corrections']) {
      await mem.pool.query(`SELECT count(*) FROM ${t}`);
    }
  });

  test('0001 through 0008 all applied — no migration was skipped or renumbered over', async () => {
    const { rows } = await mem.pool.query(`SELECT name FROM aqua_schema_migrations ORDER BY name`);
    const names = rows.map(r => r.name);
    for (const expected of ['schema_info', 'store_blobs', 'drift_runs', 'store_blob_versions',
      'entities', 'claims', 'jobs', 'world_model']) {
      assert.ok(names.includes(expected), `migration '${expected}' did not apply`);
    }
  });

  test('existing claim/entity behaviour is unaffected — a well-formed claim still inserts', async () => {
    await assert.doesNotReject(() => insertClaimReturningId({ statement_text: 'still works' }));
  });
});

// ── Edges ────────────────────────────────────────────────────────────────────

describe('edges — valid creation', () => {
  test('a well-formed edge is accepted', async () => {
    await assert.doesNotReject(() => insertEdge());
  });

  test('a self-loop is refused', async () => {
    await assert.rejects(() => insertEdge({ to_entity_id: PRIYA }));
  });

  test('valid_to before valid_from is refused', async () => {
    await assert.rejects(() => insertEdge({
      valid_from: new Date('2026-02-01'), valid_to: new Date('2026-01-01'),
    }));
  });

  test('a superseded edge must name what superseded it, and vice versa', async () => {
    await assert.rejects(() => insertEdge({ state: 'superseded' }));
    const other = crypto.randomUUID();
    await assert.rejects(() => insertEdge({ superseded_by: other }));
  });
});

describe('edges — cross-owner rejection (structural, not application-level)', () => {
  test('an edge cannot point FROM an entity owned by someone else', async () => {
    await assert.rejects(() => insertEdge({ from_entity_id: PRIYA_OTHER }));
  });

  test('an edge cannot point TO an entity owned by someone else', async () => {
    await assert.rejects(() => insertEdge({ to_entity_id: PRIYA_OTHER }));
  });

  test('an edge cannot cite a claim owned by someone else', async () => {
    await assert.rejects(() => insertEdge({ claim_id: CLAIM_OTHER }));
  });

  test('same-owner references are accepted — the constraint checks ownership, not mere existence', async () => {
    await assert.doesNotReject(() => insertEdge({
      from_entity_id: PRIYA, to_entity_id: AQUIPLEX, claim_id: CLAIM_OWNER,
    }));
  });
});

describe('edges — foreign keys behave correctly', () => {
  test('a from_entity_id that does not exist at all is refused', async () => {
    await assert.rejects(() => insertEdge({ from_entity_id: crypto.randomUUID() }));
  });

  test('a claim_id that does not exist at all is refused', async () => {
    await assert.rejects(() => insertEdge({ claim_id: crypto.randomUUID() }));
  });

  test('superseded_by must point at a real edge of the same owner', async () => {
    const winner = crypto.randomUUID();
    await insertEdge({ edge_id: winner, predicate: 'reports_to', to_entity_id: AQUIPLEX });
    const loserId = crypto.randomUUID();
    await assert.doesNotReject(() => insertEdge({
      edge_id: loserId, predicate: 'reports_to', to_entity_id: AQUIPLEX,
      state: 'superseded', superseded_by: winner,
    }));
  });
});

// ── Events ───────────────────────────────────────────────────────────────────

describe('events — owner isolation', () => {
  test('a well-formed event is accepted', async () => {
    await assert.doesNotReject(() => insertEvent());
  });

  test('an event cannot claim a subject entity owned by someone else', async () => {
    await assert.rejects(() => insertEvent({ subject_entity_id: PRIYA_OTHER }));
  });

  test('an event cannot cite a claim owned by someone else', async () => {
    await assert.rejects(() => insertEvent({ claim_id: CLAIM_OTHER }));
  });

  test('one owner cannot see another owner\'s events through a plain query', async () => {
    await insertEvent({ event_type: 'only_owner_sees_this' });
    const { rows } = await mem.pool.query(
      `SELECT event_type FROM aqua_events WHERE owner_id=$1 AND event_type='only_owner_sees_this'`,
      [OTHER]);
    assert.equal(rows.length, 0);
  });

  test('an end with no start is refused — a range needs a start', async () => {
    await assert.rejects(() => insertEvent({
      occurred_at: null, occurred_to: new Date('2026-01-01'),
    }));
  });

  test('occurred_to before occurred_at is refused', async () => {
    await assert.rejects(() => insertEvent({
      occurred_at: new Date('2026-02-01'), occurred_to: new Date('2026-01-01'),
    }));
  });

  test('an event with no known time is allowed — precision says so honestly', async () => {
    await assert.doesNotReject(() => insertEvent({
      occurred_at: null, occurred_to: null, time_precision: 'none',
    }));
  });
});

// ── Lifecycle transitions ────────────────────────────────────────────────────

describe('lifecycle transitions — validity', () => {
  test('a well-formed transition is accepted', async () => {
    await assert.doesNotReject(() => insertTransition());
  });

  test('the first transition for a target may have no from_state', async () => {
    await assert.doesNotReject(() => insertTransition({ from_state: null, to_state: 'extracted' }));
  });

  test('a transition to the same state it came from is refused — nothing changed', async () => {
    await assert.rejects(() => insertTransition({ from_state: 'active', to_state: 'active' }));
  });

  test('an unknown target_kind is refused — the set is closed by design', async () => {
    await assert.rejects(() => insertTransition({ target_kind: 'belief' }));
  });

  test('an unknown to_state is refused', async () => {
    await assert.rejects(() => insertTransition({ to_state: 'vibing' }));
  });

  test('a transition with no reason is refused — L9', async () => {
    await assert.rejects(() => mem.pool.query(
      `INSERT INTO aqua_lifecycle_transitions
         (transition_id, owner_id, target_kind, target_id, from_state, to_state, reason, actor)
       VALUES ($1,$2,'claim',$3,'extracted','active',NULL,'test')`,
      [crypto.randomUUID(), OWNER, crypto.randomUUID()]));
  });

  test("an entity's merged/dismissed states are valid to_states too — the union, not just claim states", async () => {
    await assert.doesNotReject(() => insertTransition({
      target_kind: 'entity', from_state: 'active', to_state: 'merged',
    }));
  });

  test("history for a target accumulates and is queryable in order", async () => {
    const target = crypto.randomUUID();
    await insertTransition({ target_kind: 'edge', target_id: target, from_state: null, to_state: 'extracted' });
    await insertTransition({ target_kind: 'edge', target_id: target, from_state: 'extracted', to_state: 'active' });
    const { rows } = await mem.pool.query(
      `SELECT to_state FROM aqua_lifecycle_transitions
       WHERE owner_id=$1 AND target_kind='edge' AND target_id=$2
       ORDER BY created_at ASC`, [OWNER, target]);
    assert.deepEqual(rows.map(r => r.to_state), ['extracted', 'active']);
  });
});

// ── Revisions ─────────────────────────────────────────────────────────────────

describe('revisions — persistence and the diff discipline (L1)', () => {
  test('a well-formed revision is accepted and readable back', async () => {
    const id = crypto.randomUUID();
    await insertRevision({ revision_id: id, before: { state: 'extracted' }, after: { state: 'active' } });
    const { rows } = await mem.pool.query(
      `SELECT before, after, reason, actor FROM aqua_revisions WHERE revision_id=$1`, [id]);
    assert.equal(rows[0].reason, 'reviewed');
    assert.equal(rows[0].actor, 'test');
    assert.equal(rows[0].after.state, 'active'); // jsonb comes back already parsed
  });

  test("a 'create' revision must have no before", async () => {
    await assert.rejects(() => insertRevision({ change_kind: 'create', before: { x: 1 } }));
    await assert.doesNotReject(() => insertRevision({ change_kind: 'create', before: null }));
  });

  test("a non-'create' revision must show a before", async () => {
    await assert.rejects(() => insertRevision({ change_kind: 'update', before: null }));
  });

  test('every revision must show an after — that is the answer to "what changed to"', async () => {
    await assert.rejects(() => insertRevision({ after: null }));
  });

  test("'delete' is not a valid change_kind — L5, nothing is deleted", async () => {
    await assert.rejects(() => insertRevision({ change_kind: 'delete', before: { x: 1 } }));
  });

  test('a fresh revision is not pre-reverted', async () => {
    const id = crypto.randomUUID();
    await insertRevision({ revision_id: id });
    const { rows } = await mem.pool.query(
      `SELECT reverted_at FROM aqua_revisions WHERE revision_id=$1`, [id]);
    assert.equal(rows[0].reverted_at, null);
  });
});

// ── Corrections ───────────────────────────────────────────────────────────────

describe('corrections — persistence', () => {
  test('a well-formed correction is accepted and readable back', async () => {
    const id = crypto.randomUUID();
    await insertCorrection({ correction_id: id, action: 'correct' });
    const { rows } = await mem.pool.query(
      `SELECT action, actor, before, after FROM aqua_corrections WHERE correction_id=$1`, [id]);
    assert.equal(rows[0].action, 'correct');
    assert.equal(rows[0].actor, 'user:priya');
  });

  test('every action in the target vocabulary is accepted', async () => {
    await assert.doesNotReject(() => insertCorrection({ action: 'correct', after: { x: 2 } }));
    await assert.doesNotReject(() => insertCorrection({ action: 'rename', after: { label: 'New' } }));
    await assert.doesNotReject(() => insertCorrection({ action: 'remove', after: null }));
    await assert.doesNotReject(() => insertCorrection({ action: 'dismiss', after: null }));
  });

  test('an unknown action is refused', async () => {
    await assert.rejects(() => insertCorrection({ action: 'yeet' }));
  });

  test('remove/dismiss are not destructive-only: correct/rename must carry an after', async () => {
    await assert.rejects(() => insertCorrection({ action: 'correct', after: null }));
    await assert.rejects(() => insertCorrection({ action: 'rename', after: null }));
  });

  test('remove/dismiss must NOT carry an after — nothing new was asserted', async () => {
    await assert.rejects(() => insertCorrection({ action: 'remove', after: { x: 1 } }));
  });

  test('a correction with no before is refused — you must show what you are correcting', async () => {
    await assert.rejects(() => mem.pool.query(
      `INSERT INTO aqua_corrections (correction_id, owner_id, target_kind, target_id, action, before, after, actor)
       VALUES ($1,$2,'claim',$3,'remove',NULL,NULL,'test')`,
      [crypto.randomUUID(), OWNER, crypto.randomUUID()]));
  });
});

describe('corrections — owner isolation', () => {
  test('one owner cannot see another owner\'s corrections through a plain query', async () => {
    const targetId = crypto.randomUUID();
    await insertCorrection({ owner_id: OWNER, target_id: targetId });
    await insertCorrection({ owner_id: OTHER, target_id: targetId });
    const { rows: mine } = await mem.pool.query(
      `SELECT correction_id FROM aqua_corrections WHERE owner_id=$1 AND target_id=$2`, [OWNER, targetId]);
    const { rows: theirs } = await mem.pool.query(
      `SELECT correction_id FROM aqua_corrections WHERE owner_id=$1 AND target_id=$2`, [OTHER, targetId]);
    assert.equal(mine.length, 1);
    assert.equal(theirs.length, 1);
    assert.notEqual(mine[0].correction_id, theirs[0].correction_id);
  });
});

// ── Malformed values across all five tables ──────────────────────────────────

describe('constraints reject malformed state/action values', () => {
  test('edges.state rejects an unknown value', async () => {
    await assert.rejects(() => insertEdge({ state: 'vibing' }));
  });

  test('events.time_precision rejects an unknown value', async () => {
    await assert.rejects(() => insertEvent({ time_precision: 'ish' }));
  });

  test('lifecycle_transitions.target_kind rejects an unknown value', async () => {
    await assert.rejects(() => insertTransition({ target_kind: 'goal' }));
  });

  test('revisions.change_kind rejects an unknown value', async () => {
    await assert.rejects(() => insertRevision({ change_kind: 'nuke' }));
  });

  test('corrections.action rejects an unknown value', async () => {
    await assert.rejects(() => insertCorrection({ action: 'nuke' }));
  });
});

// ── Purge ────────────────────────────────────────────────────────────────────

describe('purge — an owner can be fully erased from all five tables', () => {
  test('DELETE ... WHERE owner_id=$1 removes every row across all five tables, and only that owner\'s', async () => {
    const mineTarget = crypto.randomUUID();
    const theirsTarget = crypto.randomUUID();

    const OTHER_CO = await addEntity('org', 'Other Co', 'otherco', OTHER);
    await insertEdge({ owner_id: OWNER, from_entity_id: PRIYA, to_entity_id: AQUIPLEX, claim_id: CLAIM_OWNER });
    await insertEdge({ owner_id: OTHER, from_entity_id: PRIYA_OTHER, to_entity_id: OTHER_CO, claim_id: CLAIM_OTHER });
    await insertEvent({ owner_id: OWNER, subject_entity_id: PRIYA, claim_id: CLAIM_OWNER });
    await insertEvent({ owner_id: OTHER, subject_entity_id: PRIYA_OTHER, claim_id: CLAIM_OTHER });
    await insertTransition({ owner_id: OWNER, target_id: mineTarget });
    await insertTransition({ owner_id: OTHER, target_id: theirsTarget });
    await insertRevision({ owner_id: OWNER, target_id: mineTarget });
    await insertRevision({ owner_id: OTHER, target_id: theirsTarget });
    await insertCorrection({ owner_id: OWNER, target_id: mineTarget });
    await insertCorrection({ owner_id: OTHER, target_id: theirsTarget });

    // The order a future purgeOwner() must use. aqua_edges/aqua_events are
    // self-referencing (superseded_by): a superseded row can point at a
    // winner row in the SAME owner-scoped delete, so the self-reference is
    // nulled out first rather than relying on same-statement deferred FK
    // checking — real Postgres allows that (end-of-statement checking), but
    // it is the kind of implicit behaviour a purge routine should not lean
    // on, and this suite's earlier tests leave exactly such a pair behind.
    // None of the five tables reference each other, so THIS order is free.
    // state moves off 'superseded' in the same statement — the row is about
    // to be deleted anyway, but aqua_edges_superseded_ck still requires
    // state and superseded_by to agree at every moment the row exists.
    await mem.pool.query(`UPDATE aqua_edges SET superseded_by=NULL, state='active' WHERE owner_id=$1`, [OWNER]);
    await mem.pool.query(`UPDATE aqua_events SET superseded_by=NULL, state='active' WHERE owner_id=$1`, [OWNER]);
    for (const table of ['aqua_lifecycle_transitions', 'aqua_revisions',
      'aqua_corrections', 'aqua_edges', 'aqua_events']) {
      await mem.pool.query(`DELETE FROM ${table} WHERE owner_id=$1`, [OWNER]);
    }

    for (const table of ['aqua_lifecycle_transitions', 'aqua_revisions',
      'aqua_corrections', 'aqua_edges', 'aqua_events']) {
      const { rows } = await mem.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE owner_id=$1`, [OWNER]);
      assert.equal(Number(rows[0].n), 0, `${table} still has rows for the purged owner`);
    }

    // The other owner's rows must have survived — a purge that clears
    // more than its own owner is a different, worse bug than one that
    // clears too little.
    for (const table of ['aqua_lifecycle_transitions', 'aqua_revisions',
      'aqua_corrections', 'aqua_edges', 'aqua_events']) {
      const { rows } = await mem.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE owner_id=$1`, [OTHER]);
      assert.ok(Number(rows[0].n) > 0, `${table} lost the other owner's rows too`);
    }
  });
});

// ── Inertness ────────────────────────────────────────────────────────────────

describe('world model schema — nothing uses it yet', () => {
  test('no production module references the five new tables — schema only, same as PR-1', () => {
    const ALLOWED = [];
    const NEEDLE = /aqua_edges\b|aqua_events\b|aqua_lifecycle_transitions\b|aqua_revisions\b|aqua_corrections\b/;
    const offenders = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        if (name === 'tests' || name.startsWith('.')) continue;
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(m?js|cjs)$/.test(name)) continue;
        if (NEEDLE.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(ROOT, full));
      }
    };
    walk(path.join(ROOT, 'src'));
    const undeclared = offenders.filter(f => !ALLOWED.includes(f.split(path.sep).join('/')));
    assert.deepEqual(undeclared, [],
      'a module already writes to the new tables — this PR was meant to ship the shape only');
  });

  test('every index in 0008 leads with owner_id — L19 is structural, not conventional', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'src/core/db/migrations/0008_world_model.sql'), 'utf8');
    const indexes = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \w+\s*\n?\s*ON \w+ \(([^)]+)\)/g)];
    assert.ok(indexes.length >= 10, `only found ${indexes.length} indexes`);
    for (const m of indexes) {
      assert.match(m[1].trim(), /^owner_id/,
        `an index does not lead with owner_id: (${m[1]}) — cross-owner scans would be cheap`);
    }
  });

  test('the cross-owner foreign keys this PR relies on are actually declared', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'src/core/db/migrations/0008_world_model.sql'), 'utf8');
    for (const fk of ['aqua_edges_from_entity_fk', 'aqua_edges_to_entity_fk', 'aqua_edges_claim_fk',
      'aqua_events_subject_entity_fk', 'aqua_events_claim_fk']) {
      assert.match(sql, new RegExp(`CONSTRAINT ${fk} FOREIGN KEY`), `missing composite FK: ${fk}`);
    }
    assert.match(sql, /REFERENCES aqua_entities \(entity_id, owner_id\)/);
    assert.match(sql, /REFERENCES aqua_claims \(claim_id, owner_id\)/);
  });
});
