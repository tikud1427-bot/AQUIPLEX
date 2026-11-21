/**
 * G1-1 — source-scoped deletion of canonical (Postgres) knowledge
 * (core/worldModel/sourceDeletion.js), on the REAL migrated schema in pg-mem.
 *
 * pg-mem limits that matter here (core/tests/helpers/memoryPg.mjs + probes):
 *   · ROLLBACK does not undo writes → atomicity is proven only as "the code
 *     issues ROLLBACK and never COMMIT on failure" (test 11); real-Postgres
 *     atomicity needs the live test (sourceDeletion.live.test.js).
 *   · aqua_embeddings (pgvector) is not created → its ON DELETE CASCADE is not
 *     exercised here.
 *   · partial unique indexes are skipped → the restore-time dedup check is
 *     tested by its query, not by an index violation.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-g11-'));
process.env.AQUA_DATA_DIR = TMP;
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
const envBefore = process.env.DATABASE_URL;

let mem, restorePool, SD, poolMod;
before(async () => {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/aqua';
  poolMod = await import('../db/pool.js');
  poolMod._resetForTests();
  const { createMemoryPg } = await import('./helpers/memoryPg.mjs');
  mem = createMemoryPg();
  restorePool = poolMod._setPoolForTests(mem.pool);
  await (await import('../db/migrate.js')).migrate();
  // pg-mem artefact (measured 2026-11-20): a NON-unique PARTIAL index ignores
  // its WHERE clause and then serves lookups — e.g. aqua_jobs_running_owner_ix
  // (owner_id) WHERE state='running' made every owner-filtered job query return
  // ONLY running jobs, so queued rows looked absent. These indexes are lookup
  // accelerators with no constraint semantics; dropping them in the SIMULATOR
  // only restores correct query results. Production schema is unchanged.
  for (const ix of ['aqua_jobs_ready_ix', 'aqua_jobs_running_owner_ix', 'aqua_jobs_dead_ix', 'aqua_jobs_running_heartbeat_ix',
    'aqua_outbox_pending_idx', 'aqua_claims_subject_recent_idx', 'aqua_claims_object_recent_idx', 'aqua_claims_exact_literal_idx']) {
    await mem.pool.query(`DROP INDEX IF EXISTS ${ix}`);
  }
  SD = await import('../worldModel/sourceDeletion.js');
});
after(async () => {
  restorePool?.();
  await mem?.close();
  if (envBefore === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = envBefore;
  poolMod?._resetForTests();
});

// ── fixtures ────────────────────────────────────────────────────────────────
const uid = () => crypto.randomUUID();
const hex = (n, c) => String(c).repeat(n);
const SRC_A = `ext_${hex(12, 'a')}_`;            // connector source A (e.g. one Gmail connection)
const SRC_B = `ext_${hex(12, 'b')}_`;            // another connected source
const uko = (src, item, ver = 'abcdef123456') => `${src}${hex(16, item)}_${ver}`;
const q = (sql, p = []) => mem.pool.query(sql, p);
const count = async (table, owner, extra = '', p = []) => Number((await q(`SELECT count(*)::int AS n FROM ${table} WHERE owner_id = $1 ${extra}`, [owner, ...p])).rows[0].n);
const noVectors = () => { const removed = []; return { removed, removeVector: (ns, id) => { removed.push(id); return true; }, canonicalNamespace: o => `canonical-claims:${o}` }; };

let ownerSeq = 0;
const freshOwner = () => `user:g11-${process.pid}-${++ownerSeq}`;

async function entity(owner, label, { type = 'person', aliasSource = null, canonical = true } = {}) {
  const id = uid();
  await q(`INSERT INTO aqua_entities (entity_id, owner_id, type, canonical_label, normalized_label) VALUES ($1,$2,$3,$4,$5)`, [id, owner, type, label, label.toLowerCase()]);
  if (aliasSource !== undefined) {
    await q(`INSERT INTO aqua_entity_aliases (alias_id, owner_id, entity_id, surface_form, normalized, source_id, is_canonical) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uid(), owner, id, label, label.toLowerCase(), aliasSource, canonical]);
  }
  return id;
}
async function source(owner, ref, kind = 'document') {
  const id = uid();
  await q(`INSERT INTO aqua_sources (source_id, owner_id, kind, external_ref, title, trust_tier) VALUES ($1,$2,$3,$4,$5,3)`, [id, owner, kind, ref, 't']);
  await q(`INSERT INTO aqua_understanding_commit_ledger (commit_id, owner_id, source_id, segment_start, segment_end, extractor_version, actor) VALUES ($1,$2,$3,0,1,'v1','test')`, [uid(), owner, id]);
  return id;
}
const extSource = (owner, ukoId, chunk = 0) => source(owner, SD.externalUnderstandingRef(ukoId, chunk));
const uploadSource = owner => source(owner, `file:notes.md:chunk:0`);
const convSource = owner => source(owner, `conv-1:turn:3`, 'conversation');

/** A claim with evidence from the given sources ({ source, role }) plus its derived rows. */
async function claim(owner, subject, text, support, { state = 'active', object = null, history = true } = {}) {
  const id = uid();
  await q(`INSERT INTO aqua_claims (claim_id, owner_id, subject_entity_id, predicate, object_literal, object_entity_id, polarity, modality, asserted_at, state, extractor, extractor_version, actor, statement_text, statement_norm)
           VALUES ($1,$2,$3,'states',$4,$5,'asserted','fact',now(),$6,'test','v1','test',$7,$8)`,
    [id, owner, subject, object ? null : text, object, state, text, text.toLowerCase()]);
  for (const s of support) {
    const ev = uid();
    await q(`INSERT INTO aqua_evidence (evidence_id, owner_id, source_id, quote, checksum) VALUES ($1,$2,$3,$4,'c')`, [ev, owner, s.source, text]);
    await q(`INSERT INTO aqua_claim_evidence (owner_id, claim_id, evidence_id, role) VALUES ($1,$2,$3,$4)`, [owner, id, ev, s.role ?? 'primary']);
  }
  if (history) {
    await q(`INSERT INTO aqua_lifecycle_transitions (transition_id, owner_id, target_kind, target_id, from_state, to_state, reason, actor) VALUES ($1,$2,'claim',$3,NULL,'active','e6','test')`, [uid(), owner, id]);
    await q(`INSERT INTO aqua_revisions (revision_id, owner_id, target_kind, target_id, change_kind, before, after, reason, actor) VALUES ($1,$2,'claim',$3,'create',NULL,$4::jsonb,'e6','test')`, [uid(), owner, id, JSON.stringify({ statementText: text })]);
    await q(`INSERT INTO aqua_outbox (owner_id, event_type, aggregate_kind, aggregate_id, payload, actor) VALUES ($1,'claim.created','claim',$2,$3::jsonb,'test')`, [owner, id, JSON.stringify({ claimId: id, statementText: text })]);
    await q(`INSERT INTO aqua_claim_retrieval_bridge (owner_id, claim_id, retrieval_key) VALUES ($1,$2,$3)`, [owner, id, id]);
  }
  return id;
}
const corroboration = async (owner, id) => Number((await q('SELECT confidence_corroboration AS c FROM aqua_claims WHERE owner_id = $1 AND claim_id = $2', [owner, id])).rows[0]?.c);
const exists = async (owner, id) => (await q('SELECT 1 FROM aqua_claims WHERE owner_id = $1 AND claim_id = $2', [owner, id])).rows.length === 1;

/** Referential integrity scan for an owner (the "no orphaned references" check). */
async function orphans(owner) {
  const bad = [];
  const has = async (sql, p) => (await q(sql, p)).rows.length > 0;
  for (const r of (await q('SELECT claim_id, evidence_id FROM aqua_claim_evidence WHERE owner_id = $1', [owner])).rows) {
    if (!await has('SELECT 1 FROM aqua_claims WHERE owner_id=$1 AND claim_id=$2', [owner, r.claim_id])) bad.push(`link→claim ${r.claim_id}`);
    if (!await has('SELECT 1 FROM aqua_evidence WHERE owner_id=$1 AND evidence_id=$2', [owner, r.evidence_id])) bad.push(`link→evidence ${r.evidence_id}`);
  }
  for (const r of (await q('SELECT evidence_id, source_id FROM aqua_evidence WHERE owner_id = $1', [owner])).rows) {
    if (!await has('SELECT 1 FROM aqua_sources WHERE owner_id=$1 AND source_id=$2', [owner, r.source_id])) bad.push(`evidence→source ${r.source_id}`);
  }
  for (const [t, col] of [['aqua_edges', 'claim_id'], ['aqua_events', 'claim_id'], ['aqua_claim_retrieval_bridge', 'claim_id'], ['aqua_belief_claims', 'claim_id'], ['aqua_intervention_evidence', 'claim_id']]) {
    for (const r of (await q(`SELECT ${col} AS id FROM ${t} WHERE owner_id = $1`, [owner])).rows) {
      if (!await has('SELECT 1 FROM aqua_claims WHERE owner_id=$1 AND claim_id=$2', [owner, r.id])) bad.push(`${t}→claim ${r.id}`);
    }
  }
  for (const r of (await q('SELECT claim_id, superseded_by FROM aqua_claims WHERE owner_id = $1 AND superseded_by IS NOT NULL', [owner])).rows) {
    if (!await has('SELECT 1 FROM aqua_claims WHERE owner_id=$1 AND claim_id=$2', [owner, r.superseded_by])) bad.push(`supersede→${r.superseded_by}`);
  }
  for (const t of ['aqua_lifecycle_transitions', 'aqua_revisions', 'aqua_corrections']) {
    for (const r of (await q(`SELECT target_id FROM ${t} WHERE owner_id = $1 AND target_kind = 'claim'`, [owner])).rows) {
      if (!await has('SELECT 1 FROM aqua_claims WHERE owner_id=$1 AND claim_id=$2', [owner, r.target_id])) bad.push(`${t}→claim ${r.target_id}`);
    }
  }
  for (const r of (await q(`SELECT aggregate_id FROM aqua_outbox WHERE owner_id = $1 AND aggregate_kind = 'claim'`, [owner])).rows) {
    if (!await has('SELECT 1 FROM aqua_claims WHERE owner_id=$1 AND claim_id=$2', [owner, r.aggregate_id])) bad.push(`outbox→claim ${r.aggregate_id}`);
  }
  for (const r of (await q('SELECT source_id FROM aqua_entity_aliases WHERE owner_id = $1 AND source_id IS NOT NULL', [owner])).rows) {
    if (!await has('SELECT 1 FROM aqua_sources WHERE owner_id=$1 AND source_id::text=$2', [owner, String(r.source_id)])) bad.push(`alias→source ${r.source_id}`);
  }
  for (const r of (await q('SELECT source_id FROM aqua_understanding_commit_ledger WHERE owner_id = $1', [owner])).rows) {
    if (!await has('SELECT 1 FROM aqua_sources WHERE owner_id=$1 AND source_id=$2', [owner, r.source_id])) bad.push(`ledger→source ${r.source_id}`);
  }
  return bad;
}
const run = (owner, scope, deps = {}) => SD.forgetExternalSourceClaims(owner, scope, { ...noVectors(), ...deps });

// ── tests ───────────────────────────────────────────────────────────────────
describe('G1-1 · source-scoped canonical deletion', () => {
  test('1 · a claim supported only by the deleted source is deleted with its derived rows', async () => {
    const O = freshOwner();
    const priya = await entity(O, 'Priya', { aliasSource: null });
    const s = await extSource(O, uko(SRC_A, '1'));
    const c = await claim(O, priya, 'Priya moved the launch to April 30', [{ source: s }]);
    const v = noVectors();
    const r = await run(O, { ukoPrefix: SRC_A }, v);
    assert.equal(r.complete, true);
    assert.equal(r.counts.claimsDeleted, 1);
    assert.equal(await exists(O, c), false);
    for (const t of ['aqua_lifecycle_transitions', 'aqua_revisions']) assert.equal(await count(t, O, `AND target_id = $2`, [c]), 0, t);
    assert.equal(await count('aqua_outbox', O), 0);
    assert.equal(await count('aqua_claim_retrieval_bridge', O), 0);
    assert.deepEqual(v.removed, [c], 'canonical-claim vector not removed');
  });

  test('2 · deleting ONE supporting source keeps a shared claim', async () => {
    const O = freshOwner();
    const e = await entity(O, 'Orion');
    const g = await extSource(O, uko(SRC_A, '1'));
    const u = await uploadSource(O);
    const c = await claim(O, e, 'The Orion launch is March 15', [{ source: g }, { source: u, role: 'corroborating' }]);
    const r = await run(O, { ukoPrefix: SRC_A });
    assert.equal(r.counts.claimsDeleted, 0);
    assert.equal(r.counts.claimsKept, 1);
    assert.equal(await exists(O, c), true);
    assert.equal(await count('aqua_claim_evidence', O, 'AND claim_id = $2', [c]), 1, 'only the upload evidence remains');
  });

  test('3 + 9 · a claim with several independent sources survives and its corroboration is recomputed', async () => {
    const O = freshOwner();
    const e = await entity(O, 'Orion');
    const g = await extSource(O, uko(SRC_A, '1'));
    const u = await uploadSource(O);
    const cv = await convSource(O);
    const c = await claim(O, e, 'Orion ships in March', [{ source: g }, { source: u }, { source: cv }]);
    const { recomputeCorroborationWithClient } = await import('../claims/claimRepository.js');
    await recomputeCorroborationWithClient(mem.pool, c, O);
    assert.ok(Math.abs(await corroboration(O, c) - (1 - 1 / 3)) < 1e-6, 'fixture: 3 sources');
    await run(O, { ukoPrefix: SRC_A });
    assert.equal(await exists(O, c), true);
    assert.ok(Math.abs(await corroboration(O, c) - 0.5) < 1e-6, '2 remaining sources → 0.5');
    // contradicting evidence is not support
    const c2 = await claim(O, e, 'Orion ships in May', [{ source: await extSource(O, uko(SRC_A, '2')) }, { source: u, role: 'contradicting' }]);
    await run(O, { ukoPrefix: SRC_A });
    assert.equal(await exists(O, c2), false, 'a claim kept alive only by contradicting evidence');
  });

  test('4 · deleting one resource keeps the other resources of the same connector', async () => {
    const O = freshOwner();
    const e = await entity(O, 'Acme');
    const c1 = await claim(O, e, 'Thread one says X', [{ source: await extSource(O, uko(SRC_A, '1')) }]);
    const c2 = await claim(O, e, 'Thread two says Y', [{ source: await extSource(O, uko(SRC_A, '2')) }]);
    const r = await run(O, { ukoPrefix: `${SRC_A}${hex(16, '1')}_` });
    assert.equal(r.complete, true);
    assert.equal(await exists(O, c1), false);
    assert.equal(await exists(O, c2), true);
  });

  test('5 · deleting a connector removes the knowledge of all its resources, and nothing of another source', async () => {
    const O = freshOwner();
    const e = await entity(O, 'Acme');
    const a1 = await claim(O, e, 'A one', [{ source: await extSource(O, uko(SRC_A, '1')) }]);
    const a2 = await claim(O, e, 'A two', [{ source: await extSource(O, uko(SRC_A, '2'), 3) }]);
    const b1 = await claim(O, e, 'B one', [{ source: await extSource(O, uko(SRC_B, '1')) }]);
    const up = await claim(O, e, 'Upload', [{ source: await uploadSource(O) }]);
    const r = await run(O, { ukoPrefix: SRC_A });
    assert.equal(r.counts.claimsDeleted, 2);
    assert.deepEqual([await exists(O, a1), await exists(O, a2), await exists(O, b1), await exists(O, up)], [false, false, true, true]);
  });

  test('6 · evidence, sources and commit-ledger rows of the source are removed', async () => {
    const O = freshOwner();
    const e = await entity(O, 'Acme');
    const g = await extSource(O, uko(SRC_A, '1'));
    const u = await uploadSource(O);
    await claim(O, e, 'shared', [{ source: g }, { source: u }]);
    await claim(O, e, 'only gmail', [{ source: g }]);
    const r = await run(O, { ukoPrefix: SRC_A });
    assert.equal(await count('aqua_sources', O, 'AND source_id = $2', [g]), 0);
    assert.equal(await count('aqua_evidence', O, 'AND source_id = $2', [g]), 0);
    assert.equal(await count('aqua_understanding_commit_ledger', O, 'AND source_id = $2', [g]), 0);
    assert.equal(await count('aqua_sources', O, 'AND source_id = $2', [u]), 1);
    assert.deepEqual(r.remaining, { sources: 0, evidence: 0, claimsRemaining: 0, queuedJobs: 0, skipped: null });
  });

  test('7 + 8 · vectors, bridge, belief links, edges, events, history, outbox and evidence-less interventions go', async () => {
    const O = freshOwner();
    const priya = await entity(O, 'Priya');
    const acme = await entity(O, 'Acme', { type: 'org' });
    const g = await extSource(O, uko(SRC_A, '1'));
    const u = await uploadSource(O);
    const c = await claim(O, priya, 'Priya works at Acme', [{ source: g }], { object: acme });
    const keep = await claim(O, priya, 'Priya likes tea', [{ source: u }]);
    const edge = uid(), event = uid();
    await q(`INSERT INTO aqua_edges (edge_id, owner_id, from_entity_id, to_entity_id, predicate, claim_id) VALUES ($1,$2,$3,$4,'works_at',$5)`, [edge, O, priya, acme, c]);
    await q(`INSERT INTO aqua_events (event_id, owner_id, event_type, statement_text, claim_id) VALUES ($1,$2,'job','Priya joined Acme',$3)`, [event, O, c]);
    await q(`INSERT INTO aqua_lifecycle_transitions (transition_id, owner_id, target_kind, target_id, from_state, to_state, reason, actor) VALUES ($1,$2,'edge',$3,NULL,'active','e6','t')`, [uid(), O, edge]);
    await q(`INSERT INTO aqua_corrections (correction_id, owner_id, target_kind, target_id, action, before, after, actor) VALUES ($1,$2,'claim',$3,'remove',$4::jsonb,NULL,'user')`, [uid(), O, c, JSON.stringify({ statementText: 'x' })]);
    await q(`INSERT INTO aqua_belief_claims (owner_id, belief_id, dimension, belief_key, claim_id) VALUES ($1,'bel_1','identity','organization',$2)`, [O, c]);
    await q(`INSERT INTO aqua_outbox (owner_id, event_type, aggregate_kind, aggregate_id, payload, actor) VALUES ($1,'claim.contradiction.detected','claim',$2,$3::jsonb,'t')`, [O, keep, JSON.stringify({ incomingClaimId: c, existingClaimId: keep })]);
    await q(`INSERT INTO aqua_jobs (owner_id, kind, payload, idempotency_key) VALUES ($1,'claim.reflection.v1',$2::jsonb,'r1')`, [O, JSON.stringify({ claimId: c })]);
    const mkIv = async (claims) => {
      const iv = uid();
      await q(`INSERT INTO aqua_interventions (intervention_id, owner_id, trigger_type, cooldown_key, idempotency_key, severity, urgency, reason, message, world_state, confidence, decision, expires_at)
               VALUES ($1,$2,'deadline',$3,$4,'low',0.5,'r','m','{}'::jsonb,'{}'::jsonb,'{}'::jsonb, now() + interval '1 day')`, [iv, O, iv, iv]);
      for (const cl of claims) await q(`INSERT INTO aqua_intervention_evidence (owner_id, intervention_id, claim_id) VALUES ($1,$2,$3)`, [O, iv, cl]);
      return iv;
    };
    const ivOnly = await mkIv([c]);
    const ivMixed = await mkIv([c, keep]);
    const run1 = uid();
    await q(`INSERT INTO aqua_action_runs (run_id, owner_id, intervention_id, kind, title, plan, idempotency_key, expires_at) VALUES ($1,$2,$3,'create_reminder','t','{}'::jsonb,$4, now() + interval '1 day')`, [run1, O, ivOnly, run1]);
    await q(`INSERT INTO aqua_outbox (owner_id, event_type, aggregate_kind, aggregate_id, payload, actor) VALUES ($1,'action.proposed','action',$2,'{}'::jsonb,'t')`, [O, run1]);

    const v = noVectors();
    const r = await run(O, { ukoPrefix: SRC_A }, v);
    assert.equal(r.complete, true);
    assert.deepEqual(v.removed, [c]);
    assert.equal(await count('aqua_edges', O), 0);
    assert.equal(await count('aqua_events', O), 0);
    assert.equal(await count('aqua_lifecycle_transitions', O, `AND target_id = $2`, [edge]), 0);
    assert.equal(await count('aqua_corrections', O), 0);
    assert.equal(await count('aqua_belief_claims', O), 0);
    assert.equal(await count('aqua_outbox', O, `AND aggregate_id <> $2`, [keep]), 0, 'outbox rows for deleted rows remain');
    assert.equal(await count('aqua_outbox', O, `AND event_type = 'claim.contradiction.detected'`), 0, 'event naming the deleted claim in its payload remains');
    assert.equal(await count('aqua_jobs', O), 0);
    assert.equal(await count('aqua_interventions', O, 'AND intervention_id = $2', [ivOnly]), 0);
    assert.equal(await count('aqua_action_runs', O), 0);
    assert.equal(await count('aqua_interventions', O, 'AND intervention_id = $2', [ivMixed]), 1, 'an intervention with other evidence was deleted');
    assert.equal(await count('aqua_intervention_evidence', O, 'AND intervention_id = $2', [ivMixed]), 1);
    assert.deepEqual(await orphans(O), []);
  });

  test('10 · repeated deletion is a safe no-op', async () => {
    const O = freshOwner();
    const e = await entity(O, 'Acme');
    await claim(O, e, 'gone', [{ source: await extSource(O, uko(SRC_A, '1')) }]);
    const keep = await claim(O, e, 'kept', [{ source: await uploadSource(O) }]);
    await run(O, { ukoPrefix: SRC_A });
    const snap = async () => JSON.stringify((await q('SELECT claim_id, state, confidence_corroboration FROM aqua_claims WHERE owner_id = $1 ORDER BY claim_id', [O])).rows);
    const before = await snap();
    const r2 = await run(O, { ukoPrefix: SRC_A });
    assert.equal(r2.complete, true);
    assert.equal(Object.entries(r2.counts).filter(([, n]) => n !== 0).length, 0, `second run changed something: ${JSON.stringify(r2.counts)}`);
    assert.equal(await snap(), before);
    assert.equal(await exists(O, keep), true);
  });

  test('11 · a failure inside the transaction issues ROLLBACK, never COMMIT, and the error propagates', async () => {
    const O = freshOwner();
    const e = await entity(O, 'Acme');
    await claim(O, e, 'doomed', [{ source: await extSource(O, uko(SRC_A, '1')) }]);
    const seen = [];
    const spyPool = {
      query: (...a) => mem.pool.query(...a),
      connect: async () => {
        const c = await mem.pool.connect();
        return { query: (sql, p) => { seen.push(String(sql).trim().split(/\s+/)[0].toUpperCase()); return c.query(sql, p); }, release: () => c.release() };
      },
    };
    await assert.rejects(() => run(O, { ukoPrefix: SRC_A }, { pool: spyPool, failAfterWrites: () => { throw new Error('injected failure'); } }), /injected failure/);
    assert.equal(seen[0], 'BEGIN');
    assert.ok(seen.includes('ROLLBACK'), 'no ROLLBACK issued');
    assert.ok(!seen.includes('COMMIT'), 'COMMIT issued despite the failure');
    // Real-Postgres atomicity (that the rolled-back writes are undone) is NOT provable on pg-mem:
    // see sourceDeletion.live.test.js.
  });

  test('12 · owner isolation: another owner\'s identical knowledge is untouched; bad scopes are refused', async () => {
    const A = freshOwner(), B = freshOwner();
    const ea = await entity(A, 'Acme'), eb = await entity(B, 'Acme');
    const ca = await claim(A, ea, 'same text', [{ source: await extSource(A, uko(SRC_A, '1')) }]);
    const cb = await claim(B, eb, 'same text', [{ source: await extSource(B, uko(SRC_A, '1')) }]);
    await run(A, { ukoPrefix: SRC_A });
    assert.equal(await exists(A, ca), false);
    assert.equal(await exists(B, cb), true, 'another owner\'s knowledge was deleted');
    assert.deepEqual(await orphans(B), []);
    for (const bad of ['', 'ext_', 'file:notes.md', '4b8f6c1e-0000-0000-0000-000000000000', `ext_${hex(12, 'g')}_`, 'ext_%', `${SRC_A}%`]) {
      await assert.rejects(() => run(A, { ukoPrefix: bad }), e => e.code === 'PREFIX_INVALID', JSON.stringify(bad));
    }
    await assert.rejects(() => run('', { ukoPrefix: SRC_A }), e => e.code === 'OWNER_REQUIRED');
    await assert.rejects(() => run({ id: 'x' }, { ukoPrefix: SRC_A }), e => e.code === 'OWNER_REQUIRED');
    await assert.rejects(() => run(A, { ukoPrefix: SRC_A, keepUkoId: uko(SRC_B, '1') }), e => e.code === 'KEEP_INVALID');
  });

  test('13 · missing or already-deleted records do not corrupt the remaining data', async () => {
    const O = freshOwner();
    const e = await entity(O, 'Acme');
    await extSource(O, uko(SRC_A, '9'));                                 // a source with no evidence at all
    const g = await extSource(O, uko(SRC_A, '1'));
    const keep = await claim(O, e, 'kept', [{ source: await uploadSource(O) }]);
    const c = await claim(O, e, 'gone', [{ source: g }], { history: false });
    await q('DELETE FROM aqua_claim_evidence WHERE owner_id = $1 AND claim_id = $2', [O, c]);   // a claim whose link already vanished
    await q(`INSERT INTO aqua_jobs (owner_id, kind, payload, idempotency_key) VALUES ($1,'claim.reflection.v1',$2::jsonb,'gone')`, [O, JSON.stringify({ claimId: uid() })]);
    const r = await run(O, { ukoPrefix: SRC_A });
    assert.equal(r.complete, true);
    assert.equal(await exists(O, keep), true);
    assert.equal(await count('aqua_sources', O, `AND external_ref LIKE 'extuko:%'`), 0);
    assert.equal(await count('aqua_jobs', O), 1, 'an unrelated job was removed');
    assert.deepEqual(await orphans(O), []);
    // The orphaned claim c (no evidence, not reachable from the source) is outside this scope and reported nowhere as deleted.
    assert.equal(await exists(O, c), true);
  });

  test('14 · no orphaned references after a mixed deletion', async () => {
    const O = freshOwner();
    const p = await entity(O, 'Priya'), a = await entity(O, 'Acme', { type: 'org' });
    const g1 = await extSource(O, uko(SRC_A, '1')), g2 = await extSource(O, uko(SRC_A, '2')), u = await uploadSource(O);
    await claim(O, p, 'one', [{ source: g1 }]);
    await claim(O, p, 'two', [{ source: g1 }, { source: g2 }]);
    await claim(O, a, 'three', [{ source: g2 }, { source: u }]);
    await claim(O, a, 'four', [{ source: u }]);
    await run(O, { ukoPrefix: SRC_A });
    assert.deepEqual(await orphans(O), []);
    assert.equal(await count('aqua_claims', O), 2);
  });
});

describe('G1-1 · dependencies found by the schema investigation', () => {
  test('a claim the deleted source SUPERSEDED is restored (state from its revision; supersession cutoff cleared)', async () => {
    const O = freshOwner();
    const e = await entity(O, 'Orion');
    const old = await claim(O, e, 'launch March 15', [{ source: await uploadSource(O) }]);
    const succ = await claim(O, e, 'launch April 30', [{ source: await extSource(O, uko(SRC_A, '1')) }]);
    await q(`UPDATE aqua_claims SET state='superseded', superseded_by=$3, valid_to=now() WHERE owner_id=$1 AND claim_id=$2`, [O, old, succ]);
    await q(`INSERT INTO aqua_revisions (revision_id, owner_id, target_kind, target_id, change_kind, before, after, reason, actor) VALUES ($1,$2,'claim',$3,'supersede',$4::jsonb,$5::jsonb,'r','t')`,
      [uid(), O, old, JSON.stringify({ state: 'trusted', supersededBy: null }), JSON.stringify({ state: 'superseded', supersededBy: succ })]);
    const r = await run(O, { ukoPrefix: SRC_A });
    assert.equal(r.counts.claimsRestored, 1);
    const { rows } = await q('SELECT state, superseded_by, valid_to FROM aqua_claims WHERE owner_id=$1 AND claim_id=$2', [O, old]);
    assert.deepEqual([rows[0].state, rows[0].superseded_by, rows[0].valid_to], ['trusted', null, null]);
    assert.deepEqual(await orphans(O), []);
  });

  test('a restore that would duplicate a current claim archives instead', async () => {
    const O = freshOwner();
    const e = await entity(O, 'Orion');
    const u = await uploadSource(O);
    const old = await claim(O, e, 'launch March 15', [{ source: u }]);
    const succ = await claim(O, e, 'launch April 30', [{ source: await extSource(O, uko(SRC_A, '1')) }]);
    await q(`UPDATE aqua_claims SET state='superseded', superseded_by=$3 WHERE owner_id=$1 AND claim_id=$2`, [O, old, succ]);
    const twin = await claim(O, e, 'launch March 15', [{ source: await convSource(O) }]);   // already current again
    await run(O, { ukoPrefix: SRC_A });
    const { rows } = await q('SELECT state FROM aqua_claims WHERE owner_id=$1 AND claim_id=$2', [O, old]);
    assert.equal(rows[0].state, 'archived');
    assert.equal(await exists(O, twin), true);
  });

  test('entities: created by the source and unreferenced → deleted; still referenced → kept, alias provenance cleared; foreign alias removed', async () => {
    const O = freshOwner();
    const g = await extSource(O, uko(SRC_A, '1'));
    const u = await uploadSource(O);
    const zeph = await entity(O, 'Zephyrion', { type: 'org', aliasSource: g });       // created by the email
    const priya = await entity(O, 'Priya', { aliasSource: g });                       // created by the email, used by an upload too
    const acme = await entity(O, 'Acme', { type: 'org', aliasSource: u });             // created by the upload
    await q(`INSERT INTO aqua_entity_aliases (alias_id, owner_id, entity_id, surface_form, normalized, source_id, is_canonical) VALUES ($1,$2,$3,'ACME Inc','acme inc',$4,false)`, [uid(), O, acme, g]);
    await claim(O, zeph, 'Zephyrion signed', [{ source: g }]);
    await claim(O, priya, 'Priya likes tea', [{ source: u }]);
    await claim(O, acme, 'Acme grew', [{ source: u }]);
    const r = await run(O, { ukoPrefix: SRC_A });
    assert.equal(await count('aqua_entities', O, 'AND entity_id = $2', [zeph]), 0);
    assert.equal(await count('aqua_entities', O, 'AND entity_id = $2', [priya]), 1);
    assert.equal(await count('aqua_entity_aliases', O, 'AND entity_id = $2 AND source_id IS NULL', [priya]), 1, 'canonical alias provenance not cleared');
    assert.equal(await count('aqua_entity_aliases', O, `AND entity_id = $2 AND normalized = 'acme inc'`, [acme]), 0);
    assert.equal(await count('aqua_entity_aliases', O, 'AND entity_id = $2', [acme]), 1);
    assert.equal(r.counts.entitiesDeleted, 1);
    assert.deepEqual(await orphans(O), []);
  });

  test('jobs: queued document jobs of the prefix go; a running one is never touched and is reported; a kept version\'s job stays', async () => {
    const O = freshOwner();
    const v1 = uko(SRC_A, '1', '111111111111'), v2 = uko(SRC_A, '1', '222222222222');
    for (const [k, id, state] of [['a', v1, 'queued'], ['b', v1, 'running'], ['c', v2, 'queued'], ['d', uko(SRC_B, '1'), 'queued']]) {
      await q(`INSERT INTO aqua_jobs (owner_id, kind, payload, idempotency_key, state) VALUES ($1,'understanding.document.v1',$2::jsonb,$3,$4)`, [O, JSON.stringify({ ukoId: id, text: 'email body' }), k, state]);
    }
    const r = await run(O, { ukoPrefix: `${SRC_A}${hex(16, '1')}_`, keepUkoId: v2 });
    assert.equal(r.counts.jobs, 1);
    assert.equal(r.counts.runningJobsSkipped, 1);
    assert.deepEqual((await q('SELECT idempotency_key AS k FROM aqua_jobs WHERE owner_id=$1 ORDER BY idempotency_key', [O])).rows.map(x => x.k), ['b', 'c', 'd']);
  });

  test('version update: the old version\'s knowledge goes, the kept version\'s stays', async () => {
    const O = freshOwner();
    const e = await entity(O, 'Orion');
    const v1 = uko(SRC_A, '1', '111111111111'), v2 = uko(SRC_A, '1', '222222222222');
    const old = await claim(O, e, 'old version says X', [{ source: await extSource(O, v1) }]);
    const cur = await claim(O, e, 'new version says Y', [{ source: await extSource(O, v2) }]);
    const r = await run(O, { ukoPrefix: `${SRC_A}${hex(16, '1')}_`, keepUkoId: v2 });
    assert.equal(r.complete, true);
    assert.equal(await exists(O, old), false);
    assert.equal(await exists(O, cur), true);
  });

  test('Mind beliefs: one seeded only by the deleted claims is deleted; one with other support is kept', async () => {
    const O = freshOwner();
    const self = await entity(O, 'Me', { type: 'self' });
    const g = await extSource(O, uko(SRC_A, '1'));
    const u = await uploadSource(O);
    const c1 = await claim(O, self, 'I work at Zephyrion', [{ source: g }]);
    const c2 = await claim(O, self, 'I know Rust', [{ source: g }]);
    const c3 = await claim(O, self, 'I know Rust well', [{ source: u }]);
    await q(`INSERT INTO aqua_belief_claims (owner_id, belief_id, dimension, belief_key, claim_id) VALUES ($1,'b_org','identity','organization',$2)`, [O, c1]);
    await q(`INSERT INTO aqua_belief_claims (owner_id, belief_id, dimension, belief_key, claim_id) VALUES ($1,'b_rust','knowledge','rust',$2)`, [O, c2]);
    await q(`INSERT INTO aqua_belief_claims (owner_id, belief_id, dimension, belief_key, claim_id) VALUES ($1,'b_rust','knowledge','rust',$2)`, [O, c3]);
    const mind = { beliefs: {
      'identity:organization': { dimension: 'identity', key: 'organization', value: 'Zephyrion', evidenceCount: 1, privacy: { source: 'fact_bridge' } },
      'knowledge:rust': { dimension: 'knowledge', key: 'rust', value: 'yes', evidenceCount: 2, privacy: { source: 'fact_bridge' } },
    } };
    const mindApi = { getMind: () => mind, beliefKey: (d, k) => `${d}:${k}`, deleteBelief: (m, d, k) => delete m.beliefs[`${d}:${k}`] };
    const r = await run(O, { ukoPrefix: SRC_A }, { mind: mindApi });
    assert.equal(r.counts.beliefsDeleted, 1);
    assert.equal(r.counts.beliefsKept, 1);
    assert.deepEqual(Object.keys(mind.beliefs), ['knowledge:rust']);
  });

  test('Mind beliefs (acceptance B): a KEPT belief is left unchanged; one whose value came from the deleted source is flagged', async () => {
    const O = freshOwner();
    const ext = await extSource(O, uko(SRC_A, '1'));
    const chat = await convSource(O);
    const self = await entity(O, 'You', { type: 'self' });
    const org = await entity(O, 'Zephyrion', { type: 'org' });
    const tool = await entity(O, 'Rust', { type: 'technology' });
    // deleted, self works_at Zephyrion (supporting) → identity:organization
    const cOrg = await claim(O, self, 'I work at Zephyrion', [{ source: ext }], { object: org });
    // deleted, self uses Rust → knowledge:tech:rust, but the belief moved on
    const cUse = await claim(O, self, 'I use Rust', [{ source: ext }], { object: tool });
    // deleted, contradicting link
    const cNeg = await claim(O, self, 'I do not work at Zephyrion', [{ source: ext }], { object: org });
    // kept (chat), still supports the organization belief
    const cChat = await claim(O, self, 'I work at Zephyrion', [{ source: chat }], { object: org });
    for (const [id, p] of [[cOrg, 'works_at'], [cUse, 'uses'], [cNeg, 'works_at'], [cChat, 'works_at']]) {
      await q('UPDATE aqua_claims SET predicate = $3 WHERE owner_id = $1 AND claim_id = $2', [O, id, p]);
    }
    await q(`UPDATE aqua_claims SET polarity = 'negated' WHERE owner_id = $1 AND claim_id = $2`, [O, cNeg]);
    const link = (b, d, k, c, rel = 'supporting') => q(`INSERT INTO aqua_belief_claims (owner_id, belief_id, dimension, belief_key, claim_id, relation) VALUES ($1,$2,$3,$4,$5,$6)`, [O, b, d, k, c, rel]);
    await link('b_org', 'identity', 'organization', cOrg);
    await link('b_org', 'identity', 'organization', cChat);
    await link('b_org2', 'identity', 'employer_note', cNeg, 'contradicting');
    await link('b_rust', 'knowledge', 'tech:rust', cUse);
    const orgBelief = { dimension: 'identity', key: 'organization', value: 'Zephyrion', confidence: 0.8, evidenceCount: 3, contradictions: 0, history: [], privacy: { source: 'fact_bridge' } };
    const rustBelief = { dimension: 'knowledge', key: 'tech:rust', value: 'expert', confidence: 0.6, evidenceCount: 4, contradictions: 0, history: [], privacy: { source: 'inference' } };
    const noteBelief = { dimension: 'identity', key: 'employer_note', value: 'Zephyrion', confidence: 0.5, evidenceCount: 2, contradictions: 1, history: [], privacy: { source: 'fact_bridge' } };
    const mind = { beliefs: { 'identity:organization': orgBelief, 'knowledge:tech:rust': rustBelief, 'identity:employer_note': noteBelief } };
    const before = JSON.stringify(mind);
    const mindApi = { getMind: () => mind, beliefKey: (d, k) => `${d}:${k}`, deleteBelief: () => assert.fail('no belief here may be deleted') };
    const r = await run(O, { ukoPrefix: SRC_A }, { mind: mindApi });
    assert.equal(JSON.stringify(mind), before, 'a kept belief was modified (value, confidence, evidence or history)');
    const by = Object.fromEntries(r.beliefs.map(b => [`${b.dimension}:${b.beliefKey}`, b]));
    assert.equal(by['identity:organization'].action, 'kept');
    assert.equal(by['identity:organization'].valueFromDeletedSource, true, 'value supported by a deleted claim not flagged');
    assert.equal(by['knowledge:tech:rust'].valueFromDeletedSource, false, 'belief that moved on was flagged');
    assert.equal(by['identity:employer_note'].valueFromDeletedSource, false, 'a contradicting link was treated as support');
    assert.equal(r.counts.beliefsValueFromDeletedSource, 1);
    assert.equal(await exists(O, cChat), true);

    // A CONTRADICTING link never counts as support, even when the claim itself
    // maps to exactly the belief's key and value.
    const O2 = freshOwner();
    const ext2 = await extSource(O2, uko(SRC_A, '1'));
    const chat2 = await convSource(O2);
    const self2 = await entity(O2, 'You', { type: 'self' });
    const org2 = await entity(O2, 'Zephyrion', { type: 'org' });
    const cX = await claim(O2, self2, 'I work at Zephyrion', [{ source: ext2 }], { object: org2 });
    const cY = await claim(O2, self2, 'I work at Zephyrion', [{ source: chat2 }], { object: org2 });
    for (const id of [cX, cY]) await q(`UPDATE aqua_claims SET predicate = 'works_at' WHERE owner_id = $1 AND claim_id = $2`, [O2, id]);
    await q(`INSERT INTO aqua_belief_claims (owner_id, belief_id, dimension, belief_key, claim_id, relation) VALUES ($1,'b','identity','organization',$2,'contradicting')`, [O2, cX]);
    await q(`INSERT INTO aqua_belief_claims (owner_id, belief_id, dimension, belief_key, claim_id, relation) VALUES ($1,'b','identity','organization',$2,'supporting')`, [O2, cY]);
    const mind2 = { beliefs: { 'identity:organization': { ...orgBelief } } };
    const r2 = await run(O2, { ukoPrefix: SRC_A }, { mind: { ...mindApi, getMind: () => mind2 } });
    assert.equal(r2.beliefs[0].valueFromDeletedSource, false, 'a contradicting link was treated as support');
  });

  test('no Postgres configured: a no-op that says so', async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    poolMod._resetForTests();
    try {
      const r = await SD.forgetExternalSourceClaims('user:x', { ukoPrefix: SRC_A });
      assert.equal(r.skipped, 'postgres not configured');
      assert.equal(r.complete, true);
    } finally {
      process.env.DATABASE_URL = saved;
      poolMod._resetForTests();
      // _resetForTests drops the injected pool; without re-installing it the
      // next test's getPool() would build a REAL pg pool for the dummy URL.
      restorePool = poolMod._setPoolForTests(mem.pool);
    }
  });
});

describe('G1-1 · integration and tagging', () => {
  test('the Phase 1a.2 source deletion also removes canonical knowledge (and reports it)', async () => {
    const X = await import('../../files/externalSources.js');
    const { sourcePrefixes } = await import('../../files/externalIdentity.js');
    const O = freshOwner();
    const sourceId = 'gmail:conn_' + 'a'.repeat(20);
    const { ukoPrefix } = sourcePrefixes(sourceId);
    const e = await entity(O, 'Acme');
    const c = await claim(O, e, 'from the connected source', [{ source: await extSource(O, `${ukoPrefix}${hex(16, '3')}_abcdef123456`) }]);
    const keep = await claim(O, e, 'from an upload', [{ source: await uploadSource(O) }]);
    const r = await X.deleteExternalSource(O, sourceId);
    assert.equal(r.complete, true, JSON.stringify(r.errors));
    assert.equal(r.canonical.claimsDeleted, 1);
    assert.equal(r.removed.canonicalClaims, 1);
    assert.ok(Object.values(r.removed).every(n => typeof n === 'number'), 'removed must stay a flat map of numbers');
    assert.equal(r.remaining.canonicalSources, 0);
    assert.equal(await exists(O, c), false);
    assert.equal(await exists(O, keep), true);
  });

  test('document jobs for an external resource are keyed by its ukoId; uploads keep their key', async () => {
    const { enqueueDocumentUnderstanding } = await import('../../files/documentUnderstanding.js');
    const keys = [];
    // G1-2: an external document carries its (unrestricted) class and is enqueued
    // under the source lock in a transaction (deps.pool).
    (await import('../dataClass.js')).registerConnectorDataPolicy('keysrc', { allowedProviders: '*' });
    const deps = { enabled: async () => true, pool: mem.pool, enqueue: async j => { keys.push(j.idempotencyKey); } };
    const text = 'The same sentence in two places. '.repeat(3);
    const ext = uko(SRC_A, '1');
    await enqueueDocumentUnderstanding({ ownerId: 'user:k', documents: [{ ukoId: ext, name: 'a.md', text, hash: 'h'.repeat(64), dataClass: 'external:keysrc' }], deps });
    await enqueueDocumentUnderstanding({ ownerId: 'user:k', documents: [{ ukoId: 'b2c3d4e5-0000-0000-0000-000000000000', name: 'a.md', text, hash: 'h'.repeat(64) }], deps });
    assert.equal(keys.length, 2);
    assert.ok(keys[0].includes(ext), 'external key lacks the ukoId');
    assert.equal(keys[1], `understanding.document.v1:${'h'.repeat(32)}:0`, 'upload key changed');
    assert.notEqual(keys[0], keys[1], 'an upload and a connected source with the same bytes share one understanding');
  });
});
