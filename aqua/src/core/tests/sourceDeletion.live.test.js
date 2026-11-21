/**
 * G1-1 — LIVE checks that pg-mem cannot provide (sourceDeletion.test.js and
 * sourceDeletionRace.test.js headers):
 *
 *   L1  ATOMICITY — a deletion that fails after every write leaves EVERY table
 *       exactly as before, the race tombstone included (pg-mem's ROLLBACK does
 *       not undo writes).
 *   L2  EMBEDDINGS — real pgvector rows in aqua_embeddings are deleted with
 *       their claims (ON DELETE CASCADE; the table does not exist in pg-mem).
 *   L3  SHARED CLAIMS — a claim another source still supports survives, and so
 *       does its embedding.
 *   L4  OWNER ISOLATION — another owner with the same source tag, the same
 *       text and its own embeddings is untouched.
 *   L5  RACE, deletion first — a commit arriving while the deletion
 *       transaction is open WAITS on the per-source lock, then writes nothing.
 *   L6  RACE, commit first — a deletion queued behind an in-flight commit runs
 *       after it and removes what the commit wrote.
 *   L7  RACE, production path — worker-shaped understandTurn (scripted model,
 *       no provider) whose source is deleted DURING extraction writes nothing.
 *
 * Skips visibly without AQUA_TEST_DATABASE_URL (scripts/run-tests.mjs hands it
 * to the test as DATABASE_URL). The server must have migrations applied
 * (pgvector is required by 0012). Fake owners only; everything created is
 * purged in `after`.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.AQUA_E6 = 'on';            // L7 only: understanding with a scripted model
process.env.AQUA_SELF_ENTITY = 'on';

const { isConfigured, getPool, closePool } = await import('../db/pool.js');
const LIVE = isConfigured();
const skip = LIVE ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OWNERS = [];
const owner = tag => { const o = `user:g11-live-${tag}-${RUN}`; OWNERS.push(o); return o; };
const hex = (n, c) => String(c).repeat(n);
const PREFIX = `ext_${hex(12, 'c')}_`;
const UKO = (it = '1', ver = 'abcdef123456') => `${PREFIX}${hex(16, it)}_${ver}`;
const ITEM = (it = '1') => `${PREFIX}${hex(16, it)}_`;
const noVectors = { removeVector: () => false, canonicalNamespace: () => 'x' };
const VEC = `[${Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

after(async () => {
  if (!LIVE) return;
  const wm = await import('../worldModel/worldModelRepository.js');
  const cr = await import('../claims/claimRepository.js');
  for (const o of OWNERS) {
    await wm.purgeOwner(o); await cr.purgeOwner(o); await wm.purgeOwnerEntities(o);
  }
  await closePool();
});

// ── fixtures (plain SQL, real schema) ───────────────────────────────────────
async function seedClaim(p, o, { ref, text = `Orion ${crypto.randomUUID().slice(0, 8)}`, extraSources = [] }) {
  const ent = crypto.randomUUID(), cl = crypto.randomUUID();
  await p.query(`INSERT INTO aqua_entities (entity_id, owner_id, type, canonical_label, normalized_label) VALUES ($1,$2,'concept',$3,$4)`, [ent, o, `E${ent.slice(0, 8)}`, `e${ent.slice(0, 8)}`]);
  await p.query(`INSERT INTO aqua_claims (claim_id, owner_id, subject_entity_id, predicate, object_literal, asserted_at, state, extractor, extractor_version, actor, statement_text, statement_norm)
                 VALUES ($1,$2,$3,'states','x',now(),'active','test','v1','test',$4,$5)`, [cl, o, ent, text, text.toLowerCase()]);
  const sources = [];
  for (const [i, r] of [ref, ...extraSources].entries()) {
    const src = crypto.randomUUID(), ev = crypto.randomUUID();
    await p.query(`INSERT INTO aqua_sources (source_id, owner_id, kind, external_ref, title, trust_tier) VALUES ($1,$2,'document',$3,'t',3)`, [src, o, r]);
    await p.query(`INSERT INTO aqua_understanding_commit_ledger (commit_id, owner_id, source_id, segment_start, segment_end, extractor_version, actor) VALUES ($1,$2,$3,0,1,'v1','test')`, [crypto.randomUUID(), o, src]);
    await p.query(`INSERT INTO aqua_evidence (evidence_id, owner_id, source_id, quote, checksum) VALUES ($1,$2,$3,$4,'c')`, [ev, o, src, text]);
    await p.query(`INSERT INTO aqua_claim_evidence (owner_id, claim_id, evidence_id, role) VALUES ($1,$2,$3,$4)`, [o, cl, ev, i === 0 ? 'primary' : 'corroborating']);
    sources.push(src);
  }
  await p.query(`INSERT INTO aqua_outbox (owner_id, event_type, aggregate_kind, aggregate_id, payload, actor) VALUES ($1,'claim.created','claim',$2,$3::jsonb,'test')`, [o, cl, JSON.stringify({ claimId: cl })]);
  await p.query(`INSERT INTO aqua_revisions (revision_id, owner_id, target_kind, target_id, change_kind, before, after, reason, actor) VALUES ($1,$2,'claim',$3,'create',NULL,'{}'::jsonb,'e6','test')`, [crypto.randomUUID(), o, cl]);
  await p.query(`INSERT INTO aqua_embeddings (embedding_id, owner_id, target_kind, target_id, model_signature, vector, content_hash)
                 VALUES ($1,$2,'claim',$3,'g11-live',$4::vector,'h')`, [crypto.randomUUID(), o, cl, VEC]);
  return { claimId: cl, sources, text };
}
const count = async (p, sql, args) => Number((await p.query(sql, args)).rows[0].n);
const embeddings = (p, o, cl) => count(p, `SELECT count(*)::int AS n FROM aqua_embeddings WHERE owner_id = $1 AND target_id = $2`, [o, cl]);
const claimExists = async (p, o, cl) => (await count(p, 'SELECT count(*)::int AS n FROM aqua_claims WHERE owner_id = $1 AND claim_id = $2', [o, cl])) === 1;
const extSources = (p, o) => count(p, `SELECT count(*)::int AS n FROM aqua_sources WHERE owner_id = $1 AND external_ref LIKE 'extuko:%'`, [o]);

/** Every owner-scoped table the deletion touches, as one comparable value. */
async function snapshot(p, o) {
  const tables = ['aqua_claims', 'aqua_evidence', 'aqua_claim_evidence', 'aqua_sources', 'aqua_understanding_commit_ledger',
    'aqua_outbox', 'aqua_revisions', 'aqua_embeddings', 'aqua_entities', 'aqua_external_deletions', 'aqua_jobs'];
  const out = {};
  for (const t of tables) out[t] = (await p.query(`SELECT * FROM ${t} WHERE owner_id = $1`, [o])).rows.map(r => JSON.stringify(r)).sort();
  return JSON.stringify(out);
}

/** The commit a document job makes for an external resource (brain/index.js shape). */
async function commitExternal(o, ukoId, text, enqueuedAt) {
  const WM = await import('../worldModel/worldModelRepository.js');
  const SD = await import('../worldModel/sourceDeletion.js');
  const { canonicalTurnSourceId } = await import('../worldModel/turnSourceIdentity.js');
  const n = crypto.randomUUID().slice(0, 8);
  return WM.commitUnderstanding({
    ownerId: o, sourceId: canonicalTurnSourceId(o, `extuko:${ukoId}`, 1), actor: 'e6:live', extractorVersion: 'e6-live',
    segmentRange: { start: 0, end: text.length }, sourceKind: 'document', trustTier: 3,
    externalRef: SD.externalUnderstandingRef(ukoId, 0), title: 'External resource — live.md', enqueuedAt,
    contentHash: crypto.createHash('sha256').update(text).digest('hex'), assertedAt: new Date(),
    claims: [{
      claimId: crypto.randomUUID(), predicate: 'owns', objectKind: 'entity', subject: 'Lena', object: { entity: `Vega${n} service` },
      polarity: 'asserted', modality: 'fact', timePrecision: 'none', statementText: text,
      _canonicalSubject: { entityId: 'aq:name:lena', canonical: 'Lena', name: 'Lena', type: 'person' },
      _canonicalObject: { entityId: `aq:name:vega${n}`, canonical: `Vega${n} service`, name: `Vega${n} service`, type: 'concept' },
      resolution: { ready: true },
    }],
  });
}

/** Number of sessions WAITING (not granted) on this owner+source's advisory lock. */
async function lockWaiters(p, o, ukoId) {
  const { externalSourceLockKey } = await import('../worldModel/externalDeletionGuard.js');
  const k = BigInt.asUintN(64, BigInt(externalSourceLockKey(o, ukoId)));
  return count(p, `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
                      AND classid::bigint = $1 AND objid::bigint = $2 AND objsubid = 1`,
    [String(k >> 32n), String(k & 0xffffffffn)]);
}
async function waitFor(fn, what, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await fn()) return; await sleep(25); }
  assert.fail(`timed out waiting for: ${what}`);
}

test('G1-1 live: Postgres is available', { skip }, () => { assert.ok(LIVE); });

describe('G1-1 live', { skip }, () => {
  test('L1 · a failure after all writes rolls EVERYTHING back (tombstone, embeddings, history, ledger, entities)', async () => {
    const p = await getPool();
    const SD = await import('../worldModel/sourceDeletion.js');
    const O = owner('l1');
    const a = await seedClaim(p, O, { ref: SD.externalUnderstandingRef(UKO('1'), 0) });
    await seedClaim(p, O, { ref: SD.externalUnderstandingRef(UKO('2'), 0) });
    const before = await snapshot(p, O);
    await assert.rejects(() => SD.forgetExternalSourceClaims(O, { ukoPrefix: PREFIX }, { ...noVectors, failAfterWrites: () => { throw new Error('injected'); } }), /injected/);
    assert.equal(await snapshot(p, O), before, 'a failed deletion left partial changes');
    assert.equal(await count(p, 'SELECT count(*)::int AS n FROM aqua_external_deletions WHERE owner_id = $1', [O]), 0, 'the tombstone survived a rollback');
    // and the next attempt completes
    const ok = await SD.forgetExternalSourceClaims(O, { ukoPrefix: PREFIX }, noVectors);
    assert.equal(ok.complete, true);
    assert.equal(await claimExists(p, O, a.claimId), false);
  });

  test('L2 · embedding rows are deleted with their claims', async () => {
    const p = await getPool();
    const SD = await import('../worldModel/sourceDeletion.js');
    const O = owner('l2');
    const a = await seedClaim(p, O, { ref: SD.externalUnderstandingRef(UKO('1'), 0) });
    const b = await seedClaim(p, O, { ref: SD.externalUnderstandingRef(UKO('1'), 1) });
    assert.equal(await embeddings(p, O, a.claimId), 1);
    assert.equal(await embeddings(p, O, b.claimId), 1);
    const r = await SD.forgetExternalSourceClaims(O, { ukoPrefix: ITEM('1') }, noVectors);
    assert.equal(r.complete, true);
    assert.equal(r.counts.claimsDeleted, 2);
    assert.equal(await embeddings(p, O, a.claimId), 0);
    assert.equal(await embeddings(p, O, b.claimId), 0);
    assert.equal(await count(p, 'SELECT count(*)::int AS n FROM aqua_embeddings WHERE owner_id = $1', [O]), 0);
  });

  test('L3 · a shared claim survives with its embedding; only the deleted source\'s evidence goes', async () => {
    const p = await getPool();
    const SD = await import('../worldModel/sourceDeletion.js');
    const O = owner('l3');
    const shared = await seedClaim(p, O, { ref: SD.externalUnderstandingRef(UKO('1'), 0), extraSources: ['file:notes.md:chunk:0'] });
    const only = await seedClaim(p, O, { ref: SD.externalUnderstandingRef(UKO('1'), 1) });
    const r = await SD.forgetExternalSourceClaims(O, { ukoPrefix: PREFIX }, noVectors);
    assert.equal(r.complete, true);
    assert.equal(await claimExists(p, O, shared.claimId), true);
    assert.equal(await embeddings(p, O, shared.claimId), 1, 'the shared claim lost its embedding');
    assert.equal(await claimExists(p, O, only.claimId), false);
    assert.equal(await embeddings(p, O, only.claimId), 0);
    const refs = (await p.query(`SELECT s.external_ref FROM aqua_claim_evidence ce JOIN aqua_evidence e ON e.evidence_id = ce.evidence_id
      JOIN aqua_sources s ON s.source_id = e.source_id WHERE ce.owner_id = $1 AND ce.claim_id = $2`, [O, shared.claimId])).rows.map(x => x.external_ref);
    assert.deepEqual(refs, ['file:notes.md:chunk:0']);
  });

  test('L4 · owner isolation: another owner\'s identical source tag, text and embeddings are untouched', async () => {
    const p = await getPool();
    const SD = await import('../worldModel/sourceDeletion.js');
    const O = owner('l4a'), P = owner('l4b');
    const text = `Same words ${RUN}`;
    await seedClaim(p, O, { ref: SD.externalUnderstandingRef(UKO('1'), 0), text });
    const theirs = await seedClaim(p, P, { ref: SD.externalUnderstandingRef(UKO('1'), 0), text });
    const before = await snapshot(p, P);
    const r = await SD.forgetExternalSourceClaims(O, { ukoPrefix: PREFIX }, noVectors);
    assert.equal(r.complete, true);
    assert.equal(await snapshot(p, P), before, 'another owner\'s rows changed');
    assert.equal(await embeddings(p, P, theirs.claimId), 1);
    // and P's future jobs are not blocked by O's tombstone
    const c = await commitExternal(P, UKO('2'), `Lena owns P ${RUN}`, new Date(Date.now() - 60_000));
    assert.equal(c.claims.length, 1);
  });

  test('L5 · race, deletion first: the commit waits on the lock, then writes nothing', async () => {
    const p = await getPool();
    const SD = await import('../worldModel/sourceDeletion.js');
    const O = owner('l5');
    const enqueuedAt = new Date(Date.now() - 60_000);     // the job was enqueued before the deletion
    let release;
    const held = new Promise(r => { release = r; });
    let entered;
    const inside = new Promise(r => { entered = r; });
    const deletion = SD.forgetExternalSourceClaims(O, { ukoPrefix: PREFIX }, { ...noVectors, beforeCommit: async () => { entered(); await held; } });
    await inside;                                           // deletion holds the lock and its tombstone is uncommitted
    let settled = false;
    const commit = commitExternal(O, UKO('1'), `Lena owns L5 ${RUN}`, enqueuedAt).finally(() => { settled = true; });
    await waitFor(async () => (await lockWaiters(p, O, UKO('1'))) === 1, 'the commit to queue on the source lock');
    assert.equal(settled, false, 'the commit did not wait for the deletion');
    release();
    const [d, c] = await Promise.all([deletion, commit]);
    assert.equal(d.complete, true);
    assert.equal(c.skipped, true);
    assert.equal(c.reason, 'source-deleted');
    assert.equal(await extSources(p, O), 0);
    assert.equal(await count(p, 'SELECT count(*)::int AS n FROM aqua_claims WHERE owner_id = $1', [O]), 0);
  });

  test('L6 · race, commit first: the deletion runs after the in-flight commit and removes what it wrote', async () => {
    const p = await getPool();
    const G = await import('../worldModel/externalDeletionGuard.js');
    const SD = await import('../worldModel/sourceDeletion.js');
    const O = owner('l6');
    // Hold the source lock from a third session so the order of arrival is controlled.
    const gate = await p.connect();
    let commit, deletion;
    try {
      await gate.query('BEGIN');
      await G.lockExternalSource(gate, O, UKO('1'));
      commit = commitExternal(O, UKO('1'), `Lena owns L6 ${RUN}`, new Date(Date.now() - 60_000));
      await waitFor(async () => (await lockWaiters(p, O, UKO('1'))) === 1, 'the commit to queue first');
      deletion = SD.forgetExternalSourceClaims(O, { ukoPrefix: PREFIX }, noVectors);
      await waitFor(async () => (await lockWaiters(p, O, UKO('1'))) === 2, 'the deletion to queue second');
      await gate.query('COMMIT');
    } finally { gate.release(); }
    const c = await commit;
    assert.equal(c.claims.length, 1, 'the in-flight commit (enqueued before any deletion) should commit');
    const d = await deletion;
    assert.equal(d.complete, true);
    assert.equal(d.counts.claimsDeleted, 1, 'the deletion did not see the commit\'s rows');
    assert.equal(await extSources(p, O), 0);
    assert.equal(await count(p, 'SELECT count(*)::int AS n FROM aqua_claims WHERE owner_id = $1', [O]), 0);
    assert.equal(await count(p, 'SELECT count(*)::int AS n FROM aqua_embeddings WHERE owner_id = $1', [O]), 0);
  });

  test('L7 · production path: the source is deleted while extraction runs → the job writes nothing', async () => {
    const p = await getPool();
    const SD = await import('../worldModel/sourceDeletion.js');
    const Brain = await import('../../brain/index.js');
    const O = owner('l7');
    const id = UKO('1');
    const text = `Lena owns the Lyra${RUN} service`;
    let deleted = null;
    const callModel = async () => {
      if (!deleted) deleted = await SD.forgetExternalSourceClaims(O, { ukoPrefix: PREFIX }, noVectors);   // mid-job
      return { text: JSON.stringify({ claims: [{ subject: 'Lena', predicate: 'owns', object: { entity: `Lyra${RUN} service` }, statementText: text,
        polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9 }] }), model: 'scripted/g11-live' };
    };
    const r = await Brain.understandTurn({
      ownerId: O, conversationId: `extuko:${id}`, turn: 1, userMessage: `${text}.`, callModel,
      source: { kind: 'document', name: 'live.md', hash: 'd'.repeat(64), chunk: 0, ukoId: id, enqueuedAt: new Date(Date.now() - 60_000) },
    });
    assert.ok(deleted?.complete, 'the deletion did not run mid-job');
    const commits = r?.canonicalCommit?.commits ?? [];
    assert.ok(commits.length && commits.every(c => c.skipped && c.reason === 'source-deleted'), JSON.stringify(r?.canonicalCommit));
    assert.equal(await extSources(p, O), 0);
    assert.equal(await count(p, 'SELECT count(*)::int AS n FROM aqua_claims WHERE owner_id = $1', [O]), 0);
    assert.equal(await count(p, `SELECT count(*)::int AS n FROM aqua_outbox WHERE owner_id = $1 AND event_type = 'claim.embedding.requested'`, [O]), 0);
    const { assertUnderstood } = await import('../jobs/workerRuntime.js');
    assert.doesNotThrow(() => assertUnderstood(r));
  });

  test('catalogue: aqua_embeddings → aqua_claims is ON DELETE CASCADE', async () => {
    const p = await getPool();
    const { rows } = await p.query(`
      SELECT c.confdeltype FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid JOIN pg_class r ON r.oid = c.confrelid
       WHERE t.relname = 'aqua_embeddings' AND r.relname = 'aqua_claims' AND c.contype = 'f'`);
    assert.ok(rows.length, 'aqua_embeddings has no FK to aqua_claims (migration 0012 not applied?)');
    assert.ok(rows.every(r => r.confdeltype === 'c'), 'aqua_embeddings → aqua_claims is not ON DELETE CASCADE');
  });
});
