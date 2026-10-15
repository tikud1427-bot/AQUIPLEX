/**
 * PASS 2 (2026-10-11) — NOW vs LATER vs BEFORE, on a REAL Postgres, through the
 * production path: S5 (anchored on when it was said) → S8 → commit → outbox →
 * the contradiction worker's own handler → Context Engine + current-world.
 *
 *   current manager + "from next month my manager will be X" → the current one
 *   stays current, the change is SCHEDULED (a durable job at valid_from), and
 *   the context renders the future value as "scheduled — not yet current";
 *   a closed past location is history, a future move is scheduled, the
 *   current city stays current; a dated deadline stays visible to the
 *   current-only (structured) lane.
 *
 * Only the extraction and embedding MODELS are stood in. The drain claims
 * only jobs whose run_after has come, exactly like jobQueue.claim().
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
const USER = `ts-${run}`;
const OWNER = `user:${USER}`;
const KINDS = ['claim.embedding.v1', 'claim.reflection.v1', 'claim.contradiction.v1'];

const claim = (subject, predicate, object, statementText, extra = {}) => ({
  subject, predicate, object, statementText, polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9, ...extra,
});
const SCRIPT = new Map([
  ['My manager is Claire Hughes', [claim('self', 'reports_to', { entity: 'Claire Hughes' }, 'My manager is Claire Hughes')]],
  ['From next month my manager will be Mark Ellis', [claim('self', 'reports_to', { entity: 'Mark Ellis' }, 'From next month my manager will be Mark Ellis')]],
  ['I lived in Delhi last year', [claim('self', 'located_in', { entity: 'Delhi' }, 'I lived in Delhi last year')]],
  ['I live in Toronto', [claim('self', 'located_in', { entity: 'Toronto' }, 'I live in Toronto')]],
  ['We are moving to Vancouver in March', [claim('self', 'located_in', { entity: 'Vancouver' }, 'We are moving to Vancouver in March')]],
  ['The grant report is due on 2026-12-01', [claim('grant report', 'deadline_for', { literal: '2026-12-01' }, 'The grant report is due on 2026-12-01')]],
]);
const callModel = async (arg = {}) => {
  const seen = JSON.stringify(arg.user ?? arg);
  const key = [...SCRIPT.keys()].sort((a, b) => b.length - a.length).find(k => seen.includes(k));
  return { text: JSON.stringify({ claims: key ? SCRIPT.get(key) : [] }), model: 'scripted/temporal-state' };
};
// "Said" on a fixed day so "next month" / "in March" / "last year" are deterministic.
const SAID = '2026-10-11T10:00:00.000Z';
let turn = 0;
const say = s => Brain.understandTurn({ ownerId: OWNER, conversationId: `c-${OWNER}`, turn: ++turn, userMessage: `${s}.`, callModel, assertedAt: SAID });
const empty = () => ({ items: [], block: '', stats: {} });
const ask = q => Brain.assembleContextAsync(OWNER, q, empty, { limit: 8, taskType: 'simple_qa', canonicalOnly: true });
const q = async (sql, args) => (await (await getPool()).query(sql, args)).rows;
const row = async text => (await q(`SELECT state, valid_from, valid_to FROM aqua_claims WHERE owner_id=$1 AND statement_text=$2 LIMIT 1`, [OWNER, text]))[0];

async function drain() {
  const p = await getPool();
  for (let i = 0; i < 80; i++) {
    await dispatchReflections({ limit: 200 });
    const { rows } = await p.query(
      `UPDATE aqua_jobs SET state='running', attempts=attempts+1, claimed_by='temporal-state', updated_at=now()
        WHERE owner_id=$1 AND state='queued' AND run_after <= now() AND kind = ANY($2)
        RETURNING job_id, kind, owner_id, payload, attempts`, [OWNER, KINDS]);
    if (!rows.length) {
      const [{ n: pending }] = await q(`SELECT count(*)::int n FROM aqua_outbox WHERE owner_id=$1 AND state IN ('pending','processing')`, [OWNER]);
      const [{ n: due }] = await q(`SELECT count(*)::int n FROM aqua_jobs WHERE owner_id=$1 AND state IN ('queued','running') AND run_after <= now() AND kind = ANY($2)`, [OWNER, KINDS]);
      if (!pending && !due) return;
      await new Promise(r => setTimeout(r, 100));
      continue;
    }
    rows.sort((a, b) => (b.kind === 'claim.contradiction.v1') - (a.kind === 'claim.contradiction.v1'));
    for (const r of rows) {
      await HANDLERS[r.kind]({ jobId: r.job_id, kind: r.kind, ownerId: r.owner_id, payload: r.payload, attempts: r.attempts });
      await complete(r.job_id);
    }
  }
  throw new Error('drain did not settle');
}

after(async () => {
  __clearEmbedderForTests();
  if (LIVE) { try { await purgeOwnerData({ userId: USER }); } catch { /* best effort */ } await closePool(); }
});

describe('now vs later vs before — live Postgres (Pass 2)', { skip }, () => {
  test('S5 anchors relative dates on when it was said; a future change is SCHEDULED, not applied', async () => {
    for (const s of SCRIPT.keys()) {
      const r = await say(s);
      assert.notEqual(r?.canonicalCommit?.committed, false, `${s}: ${r?.canonicalCommit?.error}`);
    }
    await drain();
    const mark = await row('From next month my manager will be Mark Ellis');
    assert.equal(new Date(mark.valid_from).toISOString(), '2026-11-01T00:00:00.000Z');
    assert.equal(mark.valid_to, null, 'a future state is open-ended');
    assert.equal((await row('My manager is Claire Hughes')).state, 'active', 'the current manager must stay current until the change takes effect');
    const sched = await q(`SELECT run_after FROM aqua_jobs WHERE owner_id=$1 AND kind='claim.contradiction.v1' AND state='queued' AND run_after > now()`, [OWNER]);
    assert.ok(sched.some(j => new Date(j.run_after).toISOString() === '2026-11-01T00:00:00.000Z'), 'the supersession is a durable job at valid_from');

    const vancouver = await row('We are moving to Vancouver in March');
    assert.equal(new Date(vancouver.valid_from).toISOString(), '2027-03-01T00:00:00.000Z');
    assert.equal((await row('I live in Toronto')).state, 'active', 'a future move does not end the current city today');
    const delhi = await row('I lived in Delhi last year');
    assert.ok(delhi.valid_to && new Date(delhi.valid_to) < new Date(SAID), 'last year is a closed past range');
    assert.equal((await row('The grant report is due on 2026-12-01')).valid_from, null, 'a deadline date is content, not validity');
  });

  test('the answer context says what is current, what is scheduled, and keeps history out of "now"', async () => {
    const mgr = await ask('Who is my manager right now, and who will it be next month?');
    assert.match(mgr.block, /Claire Hughes/);
    assert.match(mgr.block, /Mark Ellis[^\n]*scheduled from 2026-11-01 — not yet current/, `future manager not marked scheduled:\n${mgr.block}`);
    assert.doesNotMatch(mgr.block, /Claire Hughes[^\n]*scheduled/, 'the current manager must not be marked scheduled');

    const city = await ask('Which city do I live in?');
    assert.match(city.block, /Toronto/);
    assert.doesNotMatch(city.block, /Toronto[^\n]*(?:scheduled|past, not current)/);
    assert.match(city.block, /Vancouver[^\n]*scheduled from 2027-03-01/, `future move not marked scheduled:\n${city.block}`);
    const core = city.block.split('── ALSO KNOWN ABOUT THE USER')[1] ?? '';
    assert.doesNotMatch(core, /Delhi/, 'closed past is not part of the current world');

    const due = await ask('When is the grant report due?');
    assert.match(due.block, /2026-12-01/, 'a dated deadline must stay visible before it passes');
  });
});
