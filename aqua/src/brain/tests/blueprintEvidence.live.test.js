/**
 * BLUEPRINT EVIDENCE — the whole production cognitive loop on a REAL Postgres.
 *
 *   turn → understanding (S0–S9, S6½ references) → claim + entity + evidence
 *   → transactional outbox → dispatch → durable jobs → production worker
 *   handlers (embedding → pgvector, reflection → belief + belief link,
 *   contradiction → lifecycle) → World Model update → NEXT-TURN retrieval
 *   (Context Engine incl. the dense lane over aqua_embeddings) → purge.
 *
 * The ONLY stand-ins are the two models: extraction (`callModel`, scripted per
 * sentence) and embedding (a deterministic hashed bag-of-words through the
 * provider's own test seam). Queue, outbox, handlers, policy, SQL, pgvector,
 * Context Engine and purge are production code. Proves wiring and lifecycle
 * semantics — NOT extraction quality (E6 eval) or answer quality (lift eval).
 *
 * Covered, in order: new fact · first-person reference · possessive reference ·
 * connected entity · changed fact · current-state query · historical query ·
 * correction · contradiction · replay/idempotency · owner isolation · purge.
 * Skips visibly without AQUA_TEST_DATABASE_URL.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.AQUA_E6 = 'on';
process.env.AQUA_CONTEXT_V2 = 'on';
process.env.AQUA_RETRIEVAL_V3 = 'on';
process.env.AQUA_SELF_ENTITY = 'on';

const { isConfigured, getPool, closePool } = await import('../../core/db/pool.js');
const LIVE = isConfigured();
const skip = LIVE ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';

const { __setEmbedderForTests, __clearEmbedderForTests } = await import('../../embeddings/embeddingProvider.js');
const DIM = 768;
/** Deterministic stand-in for the embedding MODEL only: hashed bag of words, L2-normalised. */
__setEmbedderForTests(async texts => texts.map(t => {
  const v = new Array(DIM).fill(0);
  for (const w of String(t).toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    v[crypto.createHash('md5').update(w).digest().readUInt32BE(0) % DIM] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}));

const Brain = await import('../index.js');
const { HANDLERS, dispatchReflections } = await import('../../core/jobs/workerRuntime.js');
const { complete } = await import('../../core/jobs/jobQueue.js');
const { getMind } = await import('../../mind/mindStore.js');
const W = await import('../../core/worldModel/worldModelRepository.js');
const { purgeOwnerData } = await import('../../account/accountPurge.js');

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const USER = `bp-a-${run}`;
const OWNER = `user:${USER}`;
const OTHER = `user:bp-b-${run}`;
const KINDS = ['claim.embedding.v1', 'claim.reflection.v1', 'claim.contradiction.v1'];

const claim = (subject, predicate, object, statementText, extra = {}) => ({
  subject, predicate, object, statementText,
  polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9, ...extra,
});
const SCRIPT = new Map([
  ['I work at Intercom', [claim('I', 'works_at', { entity: 'Intercom' }, 'I work at Intercom')]],
  ['I am a product designer', [claim('I', 'role_is', { literal: 'product designer' }, 'I am a product designer')]],
  ['My company raised a seed round', [claim('My company', 'has_status', { literal: 'raised a seed round' }, 'My company raised a seed round')]],
  ['Priya leads the billing service', [claim('Priya', 'owns', { entity: 'billing service' }, 'Priya leads the billing service')]],
  ['The billing service runs on Kafka', [claim('billing service', 'uses', { entity: 'Kafka' }, 'The billing service runs on Kafka')]],
  ['I work at Nummo now', [claim('I', 'works_at', { entity: 'Nummo' }, 'I work at Nummo now')]],
  ['I use Redis', [claim('I', 'uses', { entity: 'Redis' }, 'I use Redis')]],
  ['I do not use Redis', [claim('I', 'uses', { entity: 'Redis' }, 'I do not use Redis', { polarity: 'negated' })]],
]);
const callModel = async (arg = {}) => {
  const seen = JSON.stringify(arg);
  const key = [...SCRIPT.keys()].sort((a, b) => b.length - a.length).find(k => seen.includes(k));
  return { text: JSON.stringify({ claims: key ? SCRIPT.get(key) : [] }), model: 'scripted/blueprint-evidence' };
};
const turns = new Map();
const say = (ownerId, s, t = null) => {
  const n = t ?? (turns.get(ownerId) ?? 0) + 1;
  if (t == null) turns.set(ownerId, n);
  return Brain.understandTurn({ ownerId, conversationId: `c-${ownerId}`, turn: n, userMessage: `${s}.`, callModel });
};
const empty = () => ({ items: [], block: '', stats: {} });
const ask = async (ownerId, q) => (await Brain.assembleContextAsync(ownerId, q, empty, { limit: 8, taskType: 'simple_qa' })).block ?? '';
const q = async (sql, args) => (await (await getPool()).query(sql, args)).rows;

/** The production path from outbox to handlers, for THIS owner's rows (other live suites share the tables). */
async function drain(ownerId) {
  const p = await getPool();
  for (let i = 0; i < 80; i++) {
    await dispatchReflections({ limit: 200 });
    const { rows } = await p.query(
      `UPDATE aqua_jobs SET state='running', attempts=attempts+1, claimed_by='blueprint-evidence', updated_at=now()
        WHERE owner_id=$1 AND state='queued' AND kind = ANY($2) RETURNING job_id, kind, owner_id, payload, attempts`, [ownerId, KINDS]);
    if (!rows.length) {
      const [{ n: pending }] = await q(`SELECT count(*)::int n FROM aqua_outbox WHERE owner_id=$1 AND state IN ('pending','processing')`, [ownerId]);
      const [{ n: queued }] = await q(`SELECT count(*)::int n FROM aqua_jobs WHERE owner_id=$1 AND state IN ('queued','running') AND kind = ANY($2)`, [ownerId, KINDS]);
      if (!pending && !queued) return;
      await new Promise(r => setTimeout(r, 100));
      continue;
    }
    // Contradictions first, then reflection: the worker's queue order (priority) does the same.
    rows.sort((a, b) => KINDS.indexOf(b.kind) - KINDS.indexOf(a.kind));
    for (const r of rows) {
      await HANDLERS[r.kind]({ jobId: r.job_id, kind: r.kind, ownerId: r.owner_id, payload: r.payload, attempts: r.attempts });
      await complete(r.job_id);
    }
  }
  throw new Error('drain did not settle');
}
const claimRow = async (ownerId, text) => (await q(
  `SELECT c.claim_id, c.state, c.superseded_by, s.canonical_label subject, s.type subject_type, ev.locator
     FROM aqua_claims c
     JOIN aqua_entities s ON s.owner_id=c.owner_id AND s.entity_id=c.subject_entity_id
     LEFT JOIN aqua_claim_evidence ce ON ce.owner_id=c.owner_id AND ce.claim_id=c.claim_id
     LEFT JOIN aqua_evidence ev ON ev.owner_id=ce.owner_id AND ev.evidence_id=ce.evidence_id
    WHERE c.owner_id=$1 AND c.statement_text=$2 ORDER BY c.asserted_at LIMIT 1`, [ownerId, text]))[0] ?? null;
const counts = async ownerId => Object.fromEntries(await Promise.all([
  'aqua_claims', 'aqua_entities', 'aqua_evidence', 'aqua_sources', 'aqua_outbox', 'aqua_jobs', 'aqua_embeddings',
  'aqua_belief_claims', 'aqua_lifecycle_transitions', 'aqua_revisions', 'aqua_corrections', 'aqua_edges', 'aqua_revision_voice_state',
].map(async t => [t, (await q(`SELECT count(*)::int n FROM ${t} WHERE owner_id=$1`, [ownerId]))[0].n])));

after(async () => { __clearEmbedderForTests(); if (LIVE) await closePool(); });
test('blueprint evidence: live Postgres is available', { skip }, () => { assert.ok(LIVE); });

describe('the production cognitive loop, end to end, on live Postgres', { skip }, () => {
  test('1 · NEW FACT + FIRST-PERSON: claim, self entity, evidence, outbox → embedding row, belief + link', async () => {
    await say(OWNER, 'I work at Intercom');
    await say(OWNER, 'I am a product designer');
    const row = await claimRow(OWNER, 'I work at Intercom');
    assert.equal(row?.state, 'active');
    assert.equal(row.subject_type, 'self', 'first person must resolve to the owner\'s self entity (by type, not label)');
    assert.ok(row.locator, 'no evidence row (L4 provenance)');
    const out = await q(`SELECT event_type, state FROM aqua_outbox WHERE owner_id=$1 AND event_type IN ('claim.created','claim.embedding.requested')`, [OWNER]);
    assert.ok(out.length >= 2, `no dispatch events: ${JSON.stringify(out)}`);
    await drain(OWNER);
    const emb = await q(`SELECT count(*)::int n FROM aqua_embeddings WHERE owner_id=$1 AND target_kind='claim' AND target_id=$2`, [OWNER, row.claim_id]);
    assert.equal(emb[0].n, 1, 'embedding job did not write the vector');
    assert.equal(getMind(OWNER).beliefs['identity:organization']?.value, 'Intercom');
    const links = await q(`SELECT belief_key FROM aqua_belief_claims WHERE owner_id=$1 AND claim_id=$2`, [OWNER, row.claim_id]);
    assert.deepEqual(links.map(l => l.belief_key), ['organization']);
  });

  test('2 · POSSESSIVE REFERENCE: "my company" commits under Intercom, provenance kept', async () => {
    await say(OWNER, 'My company raised a seed round');
    const row = await claimRow(OWNER, 'My company raised a seed round');
    assert.equal(row?.subject, 'Intercom');
    assert.equal(row.locator.references?.[0]?.via, 'self works_at');
  });

  test('3 · CONNECTED ENTITY: asking about Priya reaches what her service runs on', async () => {
    await say(OWNER, 'Priya leads the billing service');
    await say(OWNER, 'The billing service runs on Kafka');
    await drain(OWNER);
    const block = await ask(OWNER, 'What does Priya work on?');
    assert.match(block, /Priya leads the billing service/, block);
    assert.match(block, /runs on Kafka/, `the connected entity's fact was not reached:\n${block}`);
  });

  test('4 · CHANGED FACT through the queue: old superseded (kept), belief follows, history versioned', async () => {
    await say(OWNER, 'I work at Nummo now');
    await drain(OWNER);
    const old = await claimRow(OWNER, 'I work at Intercom');
    const neu = await claimRow(OWNER, 'I work at Nummo now');
    assert.equal(old.state, 'superseded');
    assert.equal(old.superseded_by, neu.claim_id);
    assert.equal(getMind(OWNER).beliefs['identity:organization']?.value, 'Nummo');
  });

  test('5 · CURRENT-STATE QUERY (next turn): the current value, and the old one never as current', async () => {
    const block = await ask(OWNER, 'Where do I work?');
    assert.match(block, /I work at Nummo now/, block);
    const line = block.split('\n').find(l => l.includes('I work at Intercom'));
    assert.ok(!line || /no longer current|past/i.test(line), `superseded fact presented as current:\n${block}`);
  });

  test('6 · HISTORICAL QUERY: the superseded value is still retrievable as history', async () => {
    const block = await ask(OWNER, 'Where did I work before Nummo?');
    assert.match(block, /I work at Intercom/, `history was lost:\n${block}`);
  });

  test('7 · CORRECTION: user correction supersedes with an audit record; the next context changes', async () => {
    const row = await claimRow(OWNER, 'I am a product designer');
    const res = await W.correctClaim({ ownerId: OWNER, actor: 'user', claimId: row.claim_id, statementText: 'I am a product manager' });
    assert.ok(res);
    await drain(OWNER);
    assert.equal((await claimRow(OWNER, 'I am a product designer')).state, 'superseded');
    assert.equal((await q(`SELECT count(*)::int n FROM aqua_corrections WHERE owner_id=$1`, [OWNER]))[0].n, 1);
    assert.match(await ask(OWNER, 'What is my role?'), /I am a product manager/);
  });

  test('8 · CONTRADICTION: an unsettled polarity flip is disputed on both sides, never silently picked', async () => {
    await say(OWNER, 'I use Redis');
    await say(OWNER, 'I do not use Redis');
    await drain(OWNER);
    assert.equal((await claimRow(OWNER, 'I use Redis')).state, 'disputed');
    assert.equal((await claimRow(OWNER, 'I do not use Redis')).state, 'disputed');
  });

  test('9 · REPLAY / IDEMPOTENCY: replayed turn, re-dispatch and re-run reflection add nothing', async () => {
    const before = await counts(OWNER);
    await say(OWNER, 'I work at Intercom', 1);
    await (await getPool()).query(`UPDATE aqua_jobs SET state='queued' WHERE owner_id=$1 AND kind IN ('claim.reflection.v1','claim.embedding.v1')`, [OWNER]);
    await drain(OWNER);
    const after = await counts(OWNER);
    for (const t of ['aqua_claims', 'aqua_entities', 'aqua_evidence', 'aqua_belief_claims', 'aqua_embeddings', 'aqua_outbox', 'aqua_jobs']) {
      assert.equal(after[t], before[t], `${t}: ${before[t]} → ${after[t]} on replay`);
    }
  });

  test('10 · OWNER ISOLATION: the same words from another owner share nothing', async () => {
    await say(OTHER, 'I work at Intercom');
    await drain(OTHER);
    assert.doesNotMatch(await ask(OTHER, 'Where do I work?'), /Nummo/);
    assert.doesNotMatch(await ask(OTHER, 'What does Priya work on?'), /billing service/);
    assert.equal(getMind(OTHER).beliefs['identity:organization']?.value, 'Intercom');
    assert.equal(getMind(OWNER).beliefs['identity:organization']?.value, 'Nummo');
  });

  test('11 · PURGE: every owner-scoped row is gone; the other owner is untouched', async () => {
    const otherBefore = await counts(OTHER);
    await purgeOwnerData({ userId: USER });
    const left = await counts(OWNER);
    for (const [t, n] of Object.entries(left)) assert.equal(n, 0, `${t} still holds ${n} row(s) after purge`);
    assert.deepEqual(await counts(OTHER), otherBefore);
  });
});
