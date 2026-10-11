/**
 * PASS 2 (2026-10-11) — a RESOLVED blocker stops being current, on a REAL
 * Postgres, through the production path: S8 (blocker resolution) → commit
 * (revision locator) → outbox → the contradiction worker's own handler →
 * lifecycle (superseded, kept as history) → Context Engine.
 *
 * Shapes are the ones the production extractor emitted in a probe
 * (2026-10-11): "X is blocked because Y hasn't …" → X blocked_by Y + Y
 * has_property "hasn't …"; "Y returned …" → Y has_status "returned …".
 * An unrelated blocker of another project must stay current.
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
__setEmbedderForTests(async texts => texts.map(t => {
  const v = new Array(768).fill(0);
  for (const w of String(t).toLowerCase().match(/[a-z0-9]+/g) ?? []) v[crypto.createHash('md5').update(w).digest().readUInt32BE(0) % 768] += 1;
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}));

const Brain = await import('../index.js');
const { HANDLERS, dispatchReflections } = await import('../../core/jobs/workerRuntime.js');
const { complete } = await import('../../core/jobs/jobQueue.js');
const { purgeOwnerData } = await import('../../account/accountPurge.js');

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const USER = `br-${run}`;
const OWNER = `user:${USER}`;
const KINDS = ['claim.embedding.v1', 'claim.reflection.v1', 'claim.contradiction.v1'];
const claim = (subject, predicate, object, statementText, extra = {}) => ({
  subject, predicate, object, statementText, polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9, ...extra,
});
const SCRIPT = new Map([
  ["The visa application is blocked because the Dutch embassy hasn't returned my passport", [
    claim('visa application', 'blocked_by', { entity: 'Dutch embassy' }, 'The visa application is blocked because the Dutch embassy hasn\'t returned my passport'),
    claim('Dutch embassy', 'has_property', { literal: "hasn't returned my passport" }, "the Dutch embassy hasn't returned my passport"),
  ]],
  ['The drone project is blocked by the antenna supplier', [
    claim('drone project', 'blocked_by', { entity: 'antenna supplier' }, 'The drone project is blocked by the antenna supplier'),
  ]],
  ['The Dutch embassy is going well with the paperwork', [
    claim('Dutch embassy', 'has_property', { literal: 'going well with the paperwork' }, 'The Dutch embassy is going well with the paperwork'),
  ]],
  ['The Dutch embassy returned my passport yesterday', [
    claim('Dutch embassy', 'has_status', { literal: 'returned my passport' }, 'The Dutch embassy returned my passport yesterday'),
  ]],
]);
const callModel = async (arg = {}) => {
  const seen = JSON.stringify(arg.user ?? arg);
  const key = [...SCRIPT.keys()].sort((a, b) => b.length - a.length).find(k => seen.includes(k));
  return { text: JSON.stringify({ claims: key ? SCRIPT.get(key) : [] }), model: 'scripted/blocker-resolution' };
};
let turn = 0;
const say = s => Brain.understandTurn({ ownerId: OWNER, conversationId: `c-${OWNER}`, turn: ++turn, userMessage: `${s}.`, callModel });
const empty = () => ({ items: [], block: '', stats: {} });
const ask = q => Brain.assembleContextAsync(OWNER, q, empty, { limit: 8, taskType: 'simple_qa', canonicalOnly: true });
const q = async (sql, args) => (await (await getPool()).query(sql, args)).rows;
const stateOf = async (predicate, like) => (await q(
  `SELECT state FROM aqua_claims WHERE owner_id=$1 AND predicate=$2 AND statement_text LIKE $3 ORDER BY asserted_at LIMIT 1`, [OWNER, predicate, like]))[0]?.state;

async function drain() {
  const p = await getPool();
  for (let i = 0; i < 80; i++) {
    await dispatchReflections({ limit: 200 });
    const { rows } = await p.query(
      `UPDATE aqua_jobs SET state='running', attempts=attempts+1, claimed_by='blocker-resolution', updated_at=now()
        WHERE owner_id=$1 AND state='queued' AND run_after <= now() AND kind = ANY($2) RETURNING job_id, kind, owner_id, payload, attempts`, [OWNER, KINDS]);
    if (!rows.length) {
      const [{ n }] = await q(`SELECT count(*)::int n FROM aqua_outbox WHERE owner_id=$1 AND state IN ('pending','processing')`, [OWNER]);
      const [{ m }] = await q(`SELECT count(*)::int m FROM aqua_jobs WHERE owner_id=$1 AND state IN ('queued','running') AND run_after <= now() AND kind = ANY($2)`, [OWNER, KINDS]);
      if (!n && !m) return;
      await new Promise(r => setTimeout(r, 100));
      continue;
    }
    rows.sort((a, b) => (b.kind === 'claim.contradiction.v1') - (a.kind === 'claim.contradiction.v1'));
    for (const r of rows) { await HANDLERS[r.kind]({ jobId: r.job_id, kind: r.kind, ownerId: r.owner_id, payload: r.payload, attempts: r.attempts }); await complete(r.job_id); }
  }
  throw new Error('drain did not settle');
}

after(async () => {
  __clearEmbedderForTests();
  if (LIVE) { try { await purgeOwnerData({ userId: USER }); } catch { /* best effort */ } await closePool(); }
});

describe('blocker resolution — live Postgres (Pass 2)', { skip }, () => {
  test('a positive but non-resolving update retires nothing', async () => {
    for (const s of [...SCRIPT.keys()].slice(0, 3)) await say(s);
    await drain();
    assert.equal(await stateOf('blocked_by', 'The visa application%'), 'active');
    assert.equal(await stateOf('has_property', "%hasn't returned%"), 'active');
  });

  test('the resolution retires exactly the linked blocker and pending state, kept as history', async () => {
    const r = await say('The Dutch embassy returned my passport yesterday');
    assert.notEqual(r?.canonicalCommit?.committed, false, r?.canonicalCommit?.error);
    await drain();
    assert.equal(await stateOf('blocked_by', 'The visa application%'), 'superseded', 'the resolved blocker must not stay current');
    assert.equal(await stateOf('has_property', "%hasn't returned%"), 'superseded', 'the pending state must not stay current');
    assert.equal(await stateOf('blocked_by', 'The drone project%'), 'active', 'an unrelated project\'s blocker must stay current');
    const trail = await q(`SELECT count(*)::int n FROM aqua_lifecycle_transitions WHERE owner_id=$1 AND to_state='superseded'`, [OWNER]);
    assert.ok(trail[0].n >= 2, 'retirement is recorded as lifecycle history');

    const ctx = await ask("What's blocking my visa application right now?");
    assert.doesNotMatch(ctx.block, /visa application is blocked by[^\n]*Dutch embassy(?![^\n]*no longer current)/i,
      `the resolved blocker was presented as current:\n${ctx.block}`);
    assert.doesNotMatch(ctx.block, /"[^"]*hasn't returned my passport"(?![^\n]*no longer current)/, `the pending state leaked as current:\n${ctx.block}`);
    const drone = await ask("What's blocking the drone project?");
    assert.match(drone.block, /antenna supplier/);
  });
});
