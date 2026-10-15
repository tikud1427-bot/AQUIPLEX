/**
 * Phase 3 — CORRECTION → LEARNING, end to end, on live Postgres.
 *
 *   BEFORE   ask a question → capture the production context (prepareTurn)
 *   CORRECT  through the canonical write path — the API (`correctClaim`, what
 *            POST /brain/claims/:id/correct calls) and the conversation
 *            ("That's wrong — …", rule-11 shaped extraction) — then drain the
 *            production worker handlers deterministically
 *   AFTER    ask the SAME question → the behaviour changed, and the old
 *            assertion can no longer win
 *
 * Plus the durability matrix the mission names: duplicate delivery (same
 * correction twice, outbox dispatched twice, a job handler run twice), worker
 * retry, process restart (pool closed and reopened), negation never flattened
 * into an assertion, owner isolation, purge, and the user-visible correction
 * reference on every canonical claim an answer used.
 *
 * Only the extraction and embedding MODELS are stood in. Skips visibly without
 * AQUA_TEST_DATABASE_URL.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.AQUA_E6 = 'on';
process.env.AQUA_CONTEXT_V2 = 'on';
process.env.AQUA_RETRIEVAL_V3 = 'on';
process.env.AQUA_SELF_ENTITY = 'on';
process.env.AQUA_CANONICAL_READ = 'on';

const { isConfigured, getPool, closePool } = await import('../../core/db/pool.js');
const LIVE = isConfigured();
const skip = LIVE ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';

const { __setEmbedderForTests, __clearEmbedderForTests } = await import('../../embeddings/embeddingProvider.js');
const DIM = 768;
__setEmbedderForTests(async texts => texts.map(t => {
  const v = new Array(DIM).fill(0);
  for (const w of String(t).toLowerCase().match(/[a-z0-9]+/g) ?? []) v[crypto.createHash('md5').update(w).digest().readUInt32BE(0) % DIM] += 1;
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}));

const Brain = await import('../index.js');
const { prepareTurn, worldModelClaimRefs } = await import('../../routes/chat.js');
const { createContext } = await import('../../core/observability.js');
const { HANDLERS, dispatchReflections } = await import('../../core/jobs/workerRuntime.js');
const { complete } = await import('../../core/jobs/jobQueue.js');
const { correctClaim } = await import('../../core/worldModel/worldModelRepository.js');
const { purgeOwnerData } = await import('../../account/accountPurge.js');
const { dispatchEventTypes } = await import('../../core/worldModel/outboxEvents.js');

const USER = `corr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OWNER = `user:${USER}`;
const KINDS = ['claim.embedding.v1', 'claim.reflection.v1', 'claim.contradiction.v1'];

const claim = (subject, predicate, object, statementText, extra = {}) => ({
  subject, predicate, object, statementText, polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9, ...extra,
});
const SCRIPT = new Map([
  ['I work at Acme Robotics', [claim('I', 'works_at', { entity: 'Acme Robotics' }, 'I work at Acme Robotics')]],
  ["That's wrong, I work at Globex, not Acme Robotics", [
    claim('I', 'works_at', { entity: 'Globex' }, 'I work at Globex', { revises: true }),
    claim('I', 'works_at', { entity: 'Acme Robotics' }, 'not Acme Robotics', { revises: true, polarity: 'negated' })]],
  ['I am a junior analyst', [claim('I', 'role_is', { literal: 'junior analyst' }, 'I am a junior analyst')]],
  ["I don't work at Initech anymore", [claim('I', 'works_at', { entity: 'Initech' }, "I don't work at Initech anymore", { polarity: 'negated' })]],
]);
const callModel = async (arg = {}) => {
  const seen = JSON.stringify(arg);
  const key = [...SCRIPT.keys()].sort((a, b) => b.length - a.length).find(k => seen.includes(k));
  return { text: JSON.stringify({ claims: key ? SCRIPT.get(key) : [] }), model: 'scripted/correction' };
};

let turn = 0;
async function say(text, conv = `c-${crypto.randomUUID()}`) {
  const requestId = crypto.randomUUID();
  await prepareTurn({ userMessage: `${text}.`, conversationId: conv, userId: USER, ctx: createContext({ conversationId: conv, requestId }), requestId, skipReasoningPass: true });
  await Brain.understandTurn({ ownerId: OWNER, conversationId: conv, turn: ++turn, userMessage: `${text}.`, callModel });
}
/** The production context for a question, in a NEW conversation. */
async function ask(question) {
  const conv = `ask-${crypto.randomUUID()}`;
  const requestId = crypto.randomUUID();
  const prep = await prepareTurn({ userMessage: question, conversationId: conv, userId: USER, ctx: createContext({ conversationId: conv, requestId }), requestId, skipReasoningPass: true });
  return { block: `${prep.memoryBlock}\n${prep.knowledgeContext}`, prep };
}
/** Drain this owner's outbox + jobs with the PRODUCTION handlers. `twice` re-runs every handler (at-least-once delivery). */
async function drain({ twice = false } = {}) {
  const p = await getPool();
  for (let i = 0; i < 120; i++) {
    await dispatchReflections({ limit: 200 });
    if (twice) await dispatchReflections({ limit: 200 });   // duplicate dispatch of the same outbox rows
    const { rows } = await p.query(
      `UPDATE aqua_jobs SET state='running', attempts=attempts+1, claimed_by='corr-test', updated_at=now()
        WHERE owner_id=$1 AND state='queued' AND kind = ANY($2) RETURNING job_id, kind, owner_id, payload, attempts`, [OWNER, KINDS]);
    if (!rows.length) {
      const { rows: [{ n }] } = await p.query(
        `SELECT (SELECT count(*) FROM aqua_outbox WHERE owner_id=$1 AND state IN ('pending','processing'))
              + (SELECT count(*) FROM aqua_jobs WHERE owner_id=$1 AND state IN ('queued','running') AND kind = ANY($2)) AS n`, [OWNER, KINDS]);
      if (!Number(n)) return;
      await new Promise(r => setTimeout(r, 100));
      continue;
    }
    rows.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
    for (const r of rows) {
      const job = { jobId: r.job_id, kind: r.kind, ownerId: r.owner_id, payload: r.payload, attempts: r.attempts };
      await HANDLERS[r.kind](job);
      if (twice) await HANDLERS[r.kind](job);                  // the same job delivered again
      await complete(r.job_id);
    }
  }
  throw new Error('drain did not settle');
}
const q = async (sql, params) => (await (await getPool()).query(sql, params)).rows;
const claimsBy = text => q(
  `SELECT claim_id, state, polarity, superseded_by, extractor FROM aqua_claims WHERE owner_id=$1 AND statement_text=$2 ORDER BY created_at`, [OWNER, text]);
/** Row counts that must not move under replay / duplicate delivery. */
const snapshot = async () => Object.fromEntries(await Promise.all(
  ['aqua_claims', 'aqua_corrections', 'aqua_lifecycle_transitions', 'aqua_claim_evidence', 'aqua_belief_claims']
    .map(async t => [t, (await q(`SELECT count(*)::int AS n FROM ${t} WHERE owner_id=$1`, [OWNER]))[0].n])));

describe('Phase 3 — a correction changes the World Model, retrieval and the next answer', { skip }, () => {
  after(async () => {
    __clearEmbedderForTests();
    delete process.env.AQUA_CANONICAL_READ;
    if (!LIVE) return;
    await purgeOwnerData({ userId: USER });
    await closePool();
  });

  // ── conversational correction (scenario 6) ────────────────────────────────
  test('BEFORE: the World Model answers "Acme Robotics"', async () => {
    await say('I work at Acme Robotics');
    await drain();
    const { block } = await ask('Where do I work?');
    assert.match(block, /Acme Robotics/, `before the correction the context should carry Acme:\n${block}`);
  });

  test('CORRECT in conversation → AFTER: the same question gets Globex; Acme cannot win', async () => {
    await say("That's wrong, I work at Globex, not Acme Robotics");
    await drain();
    const [acme] = await claimsBy('I work at Acme Robotics');
    assert.equal(acme.state, 'superseded', 'the corrected claim is retired');
    assert.ok(acme.superseded_by, 'and points at its successor');
    const { block } = await ask('Where do I work?');
    assert.match(block, /Globex/, `after the correction the context must carry Globex:\n${block}`);
    assert.doesNotMatch(block, /^• User works at Acme Robotics/m, `the old assertion is still offered as current:\n${block}`);
    assert.match(block, /NOT: User works at Acme Robotics/, 'the correction itself is visible as a negation');
  });

  // ── API correction (POST /brain/claims/:id/correct) ───────────────────────
  let roleClaimId = null;
  let correction = null;
  test('API correction: role "junior analyst" → "senior analyst", provenance + actor recorded', async () => {
    await say('I am a junior analyst');
    await drain();
    const before = await ask('What is my role?');
    assert.match(before.block, /junior analyst/);
    [{ claim_id: roleClaimId }] = await claimsBy('I am a junior analyst');
    correction = await correctClaim({ ownerId: OWNER, actor: 'user', claimId: roleClaimId,
      statementText: 'I am a senior analyst', object: { literal: 'senior analyst' }, correctionId: crypto.randomUUID() });
    await drain();
    const after = await ask('What is my role?');
    assert.match(after.block, /senior analyst/, `after the API correction:\n${after.block}`);
    assert.doesNotMatch(after.block, /has the role junior analyst/, `the corrected value still wins:\n${after.block}`);
    const [row] = await q(`SELECT actor, before, after FROM aqua_corrections WHERE owner_id=$1 AND correction_id=$2`, [OWNER, correction.correctionId]);
    assert.equal(row.actor, 'user', 'every write has an actor');
    assert.equal(row.before.claimId, roleClaimId, 'the correction records what it replaced');
    const [succ] = await q(`SELECT extractor, confidence_source FROM aqua_claims WHERE owner_id=$1 AND claim_id=$2`, [OWNER, correction.claimId]);
    assert.equal(succ.extractor, 'user-correction');
    assert.ok(succ.confidence_source >= 0.9, 'a user correction carries the user-explicit trust tier');
  });

  test('DUPLICATE correction (same key, or same statement re-posted) replays — one successor, nothing new written', async () => {
    const s0 = await snapshot();
    const again = await correctClaim({ ownerId: OWNER, actor: 'user', claimId: roleClaimId,
      statementText: 'I am a senior analyst', object: { literal: 'senior analyst' }, correctionId: correction.correctionId });
    assert.equal(again.replayed, true);
    assert.equal(again.claimId, correction.claimId);
    const resent = await correctClaim({ ownerId: OWNER, actor: 'user', claimId: roleClaimId,
      statementText: 'I am a senior analyst', object: { literal: 'senior analyst' } });
    assert.equal(resent.replayed, true, 'a double-submit without a key is still recognised');
    assert.deepEqual(await snapshot(), s0, 'a replayed correction wrote rows');
  });

  test('a DIFFERENT correction of an already-superseded claim is refused, naming the successor', async () => {
    await assert.rejects(
      correctClaim({ ownerId: OWNER, actor: 'user', claimId: roleClaimId, statementText: 'I am a principal analyst', object: { literal: 'principal analyst' } }),
      /already superseded by .* correct the current claim/);
  });

  test('DUPLICATE DELIVERY + RETRY: every outbox row dispatched twice and every job run twice changes nothing', async () => {
    const s0 = await snapshot();
    // Re-open every outbox row of this owner as if a crashed dispatcher never acked it.
    // Only DISPATCH rows have a consumer; record rows are the delta log (outboxEvents.js).
    await q(`UPDATE aqua_outbox SET state='pending' WHERE owner_id=$1 AND state='published' AND event_type = ANY($2)`, [OWNER, dispatchEventTypes()]);
    await drain({ twice: true });
    assert.deepEqual(await snapshot(), s0, 'replayed delivery mutated the World Model');
    const { block } = await ask('Where do I work?');
    assert.match(block, /Globex/);
  });

  test('RESTART: a fresh connection pool (new process view) still sees only the corrected state', async () => {
    await closePool();
    const { block } = await ask('What is my role?');
    assert.match(block, /senior analyst/);
    assert.doesNotMatch(block, /has the role junior analyst/);
  });

  // ── negation (scenario 3) ────────────────────────────────────────────────
  test('NEGATION is never flattened: "I don\'t work at Initech anymore" is never offered as employment', async () => {
    await say("I don't work at Initech anymore");
    await drain();
    const [neg] = await claimsBy("I don't work at Initech anymore");
    assert.equal(neg.polarity, 'negated');
    const { block } = await ask('Do I work at Initech?');
    assert.doesNotMatch(block, /(^|• )User works at Initech/m, `a negation was rendered as an assertion:\n${block}`);
    if (/Initech/.test(block)) assert.match(block, /NOT: User works at Initech/, 'when shown, it is shown negated');
  });

  // ── user-visible correction reference ─────────────────────────────────────
  test('every canonical claim an answer used carries its correction reference', async () => {
    const { prep } = await ask('Where do I work?');
    const refs = worldModelClaimRefs(prep.knowledgeItems);
    assert.ok(refs.length >= 1, 'no canonical claim reference exposed');
    for (const r of refs) {
      assert.match(r.correct, /^\/brain\/claims\/[0-9a-f-]{36}\/correct$/);
      assert.match(r.history, /^\/brain\/claims\/[0-9a-f-]{36}\/history$/);
    }
    const [globex] = await claimsBy('I work at Globex');
    assert.ok(refs.some(r => r.claimId === globex.claim_id), 'the claim the answer relied on is correctable');
  });

  // ── isolation + purge ─────────────────────────────────────────────────────
  test('OWNER ISOLATION: another owner can neither see nor correct these claims', async () => {
    await assert.rejects(correctClaim({ ownerId: `${OWNER}-other`, actor: 'user', claimId: correction.claimId, statementText: 'hijack' }), /not found/);
    const res = await Brain.assembleContextAsync(`${OWNER}-other`, 'Where do I work?', () => ({ items: [], block: '', stats: {} }), { limit: 8, canonicalOnly: true });
    assert.doesNotMatch(res.block ?? '', /Globex|Acme|analyst/);
  });

  test('LEARNING METRICS count both correction paths, their latency, and no repeated error', async () => {
    const { learningStats } = await import('../../core/worldModel/canonicalReadModel.js');
    const m = await learningStats(OWNER, { sinceDays: 2 });
    const sum = k => m.corrections.reduce((n, w) => n + w[k], 0);
    assert.equal(sum('explicitCorrections'), 1, 'the API correction is counted once (the replays are not)');
    assert.ok(sum('conversationalRevisions') >= 1, 'the in-conversation correction is counted');
    assert.equal(m.correctionLatencyHours.n, 1);
    assert.ok(m.correctionLatencyHours.median >= 0);
    assert.equal(m.repeatedErrors.pairs, 0);
  });

  test('PURGE removes the corrections, the claims and their history', async () => {
    const report = await purgeOwnerData({ userId: USER });
    assert.deepEqual(report.errors ?? [], []);
    const left = await snapshot();
    for (const [t, n] of Object.entries(left)) assert.equal(n, 0, `${t} still holds ${n} row(s) after purge`);
  });
});
