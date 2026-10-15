/**
 * E9 J3 consolidation as a durable scheduled job, on a REAL Postgres, through
 * the production path:
 *   two concurrent turns (same fact, different wording) → two current claims
 *   (the race S8 cannot see) → scheduleConsolidation → aqua_jobs →
 *   runOneJob (real claim/complete/fail) → consolidateClaimDuplicate →
 *   archived duplicate + evidence on the survivor + lifecycle/revision/outbox
 *   → the next context shows the fact once → /metrics counts it.
 * Only extraction is scripted. Skips visibly without AQUA_TEST_DATABASE_URL.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.AQUA_E6 = 'on';
process.env.AQUA_SELF_ENTITY = 'on';
process.env.AQUA_CONTEXT_V2 = 'on';
process.env.AQUA_RETRIEVAL_V3 = 'on';

const { isConfigured, getPool, closePool } = await import('../../core/db/pool.js');
const LIVE = isConfigured();
const skip = LIVE ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';

const Brain = await import('../index.js');
const { runOneJob, scheduleConsolidation } = await import('../../core/jobs/workerRuntime.js');
const { enqueue } = await import('../../core/jobs/jobQueue.js');
const { CONSOLIDATION_KIND, runClaimConsolidationJob } = await import('../reflectionV3/consolidationWorker.js');
const { publishProcessMetrics } = await import('../../core/processMetrics.js');

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OWNER = `j3-a-${run}`;
const OTHER = `j3-b-${run}`;
const RACE = `j3-r-${run}`;
const claim = (statementText) => ({ subject: 'I', predicate: 'works_at', object: { entity: 'Intercom' }, statementText,
  polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9 });

/** Both turns' extraction resolves together, so both read history before either commits. */
function barrierModel(n) {
  let waiting = [];
  return async (arg = {}) => {
    const seen = JSON.stringify(arg);
    const text = ['I am working at Intercom', 'I work at Intercom', 'Intercom is where I work'].find(s => seen.includes(s));
    // Release when all n have arrived — or after 300 ms, because a sentence
    // already in the extraction cache never reaches the model (those turns run
    // concurrently anyway).
    await new Promise(r => {
      waiting.push(r);
      if (waiting.length >= n) { waiting.forEach(f => f()); waiting = []; } else setTimeout(r, 300);
    });
    return { text: JSON.stringify({ claims: text ? [claim(text)] : [] }), model: 'scripted/j3' };
  };
}
let turn = 0;
async function duplicates(ownerId, sentences) {
  const callModel = barrierModel(sentences.length);
  await Promise.all(sentences.map(s => Brain.understandTurn({
    ownerId, conversationId: `c-${ownerId}-${++turn}`, turn: 1, userMessage: `${s}.`, callModel })));
}
const q = async (sql, args) => (await (await getPool()).query(sql, args)).rows;
const worksAt = ownerId => q(`SELECT claim_id, state, statement_text FROM aqua_claims WHERE owner_id=$1 AND predicate='works_at' ORDER BY created_at, claim_id`, [ownerId]);
/** Run queued consolidation jobs for one owner through the production claim → handler → complete path. */
async function runConsolidationJobs(ownerId) {
  const out = [];
  for (let i = 0; i < 10; i++) {
    const [{ n }] = await q(`SELECT count(*)::int n FROM aqua_jobs WHERE owner_id=$1 AND kind=$2 AND state='queued'`, [ownerId, CONSOLIDATION_KIND]);
    if (!n) break;
    // Leftover jobs of other owners may be queued; claim only consolidation jobs, and only ours count.
    const r = await runOneJob(`j3-test-${run}`, { kinds: [CONSOLIDATION_KIND] });
    if (r) out.push(r);
  }
  return out.filter(r => r.ownerId === ownerId);
}

after(async () => { if (LIVE) await closePool(); });
test('J3 consolidation: live Postgres is available', { skip }, () => { assert.ok(LIVE); });

describe('E9 J3 consolidation on live Postgres', { skip }, () => {
  test('concurrent turns produce structural duplicates (the race S8 cannot see)', async () => {
    await duplicates(OWNER, ['I work at Intercom', 'I am working at Intercom']);
    await duplicates(OTHER, ['I work at Intercom', 'I am working at Intercom']);
    const rows = await worksAt(OWNER);
    assert.equal(rows.filter(r => r.state === 'active').length, 2, `precondition: two current duplicates, got ${JSON.stringify(rows)}`);
  });

  test('scheduled once per owner per interval, durably, however many workers schedule', async () => {
    const now = Date.now();
    await scheduleConsolidation({ intervalMs: 600_000, now, limit: 1000 });
    const again = await scheduleConsolidation({ intervalMs: 600_000, now, limit: 1000 });
    const jobs = await q(`SELECT payload, priority, max_attempts FROM aqua_jobs WHERE owner_id=$1 AND kind=$2`, [OWNER, CONSOLIDATION_KIND]);
    assert.equal(jobs.length, 1, 'idempotency key must dedup the second scheduling pass');
    assert.ok(again.created >= 0);
    assert.equal(jobs[0].max_attempts, 5);
  });

  test('the job archives the duplicate, keeps provenance on the survivor, and records the merge', async () => {
    const [a, b] = await worksAt(OWNER);
    const results = await runConsolidationJobs(OWNER);
    assert.deepEqual(results.map(r => r.ok), [true]);
    const rows = await worksAt(OWNER);
    assert.deepEqual(rows.map(r => r.state).sort(), ['active', 'archived']);
    const survivor = rows.find(r => r.state === 'active');
    const absorbed = rows.find(r => r.state === 'archived');
    assert.ok([a.claim_id, b.claim_id].includes(survivor.claim_id));
    const ev = await q(`SELECT role FROM aqua_claim_evidence WHERE owner_id=$1 AND claim_id=$2 ORDER BY role`, [OWNER, survivor.claim_id]);
    assert.deepEqual(ev.map(e => e.role), ['corroborating', 'primary'], 'the absorbed claim\'s evidence must now support the survivor');
    assert.equal((await q(`SELECT count(*)::int n FROM aqua_claim_evidence WHERE owner_id=$1 AND claim_id=$2`, [OWNER, absorbed.claim_id]))[0].n, 1,
      'the archived claim keeps its own evidence (non-destructive)');
    const [lt] = await q(`SELECT from_state, to_state, reason, actor FROM aqua_lifecycle_transitions WHERE owner_id=$1 AND target_id=$2 AND to_state='archived'`, [OWNER, absorbed.claim_id]);
    assert.equal(lt.actor, 'e9:j3-consolidation');
    assert.match(lt.reason, new RegExp(survivor.claim_id));
    const [rev] = await q(`SELECT change_kind, after FROM aqua_revisions WHERE owner_id=$1 AND target_id=$2 AND change_kind='merge'`, [OWNER, absorbed.claim_id]);
    assert.equal(rev.after.mergedInto, survivor.claim_id);
    const [ob] = await q(`SELECT state FROM aqua_outbox WHERE owner_id=$1 AND event_type='world-model.consolidation' AND aggregate_id=$2`, [OWNER, absorbed.claim_id]);
    assert.equal(ob.state, 'published', 'a record event, never left pending');
  });

  test('the next context shows the fact once', async () => {
    const empty = () => ({ items: [], block: '', stats: {} });
    const block = (await Brain.assembleContextAsync(OWNER, 'Where do I work?', empty, { limit: 8, taskType: 'simple_qa' })).block ?? '';
    const hits = block.split('\n').filter(l => /Intercom/.test(l) && /work/.test(l));
    assert.equal(hits.length, 1, block);
  });

  test('idempotent: re-running the job merges nothing and changes nothing', async () => {
    const before = await worksAt(OWNER);
    const r = await runClaimConsolidationJob({ ownerId: OWNER });
    assert.deepEqual([r.groups, r.merged], [0, 0]);
    assert.deepEqual(await worksAt(OWNER), before);
  });

  test('owner isolation: every merge was made by a job of the SAME owner', async () => {
    // The scheduler also queued OTHER (it has duplicates too), and its own job
    // ran in the loop above — so the check is provenance, not "untouched".
    const rows = await q(
      `SELECT o.owner_id, j.owner_id AS job_owner
         FROM aqua_outbox o JOIN aqua_jobs j ON j.job_id = (o.payload->>'jobId')::bigint
        WHERE o.event_type='world-model.consolidation' AND o.owner_id = ANY($1)`, [[OWNER, OTHER]]);
    assert.ok(rows.length >= 1);
    for (const r of rows) assert.equal(r.job_owner, r.owner_id, 'a job merged claims of another owner');
    const other = await worksAt(OTHER);
    assert.ok(other.filter(r => r.state === 'active').length >= 1, 'the other owner kept a current claim');
  });

  test('concurrent jobs on one owner: exactly n-1 merges in total, the rest raced, no errors', async () => {
    await duplicates(RACE, ['I work at Intercom', 'I am working at Intercom', 'Intercom is where I work']);
    const current = (await worksAt(RACE)).filter(r => r.state === 'active').length;
    assert.ok(current >= 2, `precondition: duplicates, got ${current}`);
    const rs = await Promise.all([1, 2, 3].map(() => runClaimConsolidationJob({ ownerId: RACE })));
    assert.equal(rs.reduce((n, r) => n + r.merged, 0), current - 1);
    assert.equal((await worksAt(RACE)).filter(r => r.state === 'active').length, 1);
  });

  test('a failing consolidation job retries and dead-letters through the real queue', async () => {
    const owner = `j3-dlq-${run}`;
    await enqueue({ ownerId: owner, kind: CONSOLIDATION_KIND, payload: {}, idempotencyKey: `j3:dlq:${run}`, priority: 0, maxAttempts: 1 });
    const boom = { [CONSOLIDATION_KIND]: async job => runClaimConsolidationJob(job, { groupsFor: async () => { throw new Error('simulated failure'); } }) };
    let r = null;
    for (let i = 0; i < 20 && r?.ownerId !== owner; i++) r = await runOneJob(`j3-dlq-${run}`, { kinds: [CONSOLIDATION_KIND], handlers: boom });
    assert.equal(r?.ownerId, owner);
    assert.equal(r.state, 'dead');
    const [{ state }] = await q(`SELECT state FROM aqua_jobs WHERE owner_id=$1`, [owner]);
    assert.equal(state, 'dead');
  });

  test('/metrics shows J3 and revision-voice counters, including other server processes', async () => {
    await Brain.revisionDirectiveForTurn(OWNER, { taskType: 'coding', conversationId: 'x' });   // a skipped turn
    await publishProcessMetrics({ role: 'server', processId: `srv-${run}` });
    const { default: healthRoute } = await import('../../routes/health.js');
    const app = express(); app.use('/health', healthRoute);
    const server = app.listen(0);
    try {
      const text = await (await fetch(`http://127.0.0.1:${server.address().port}/health/metrics`)).text();
      assert.match(text, /^aqua_j3_merged_total [1-9]/m);
      assert.match(text, /^aqua_revision_voice_skipped_total\{reason="unsuitable-turn"\} [1-9]/m);
      assert.match(text, new RegExp(`aqua_server_revision_voice_skipped_total\\{process="srv-${run}",reason="unsuitable-turn"\\} [1-9]`));
      assert.match(text, /aqua_jobs_window\{kind="claim\.consolidation\.v1",state="(done|dead)"\}/);
    } finally {
      server.close();
      await (await getPool()).query('DELETE FROM aqua_process_metrics WHERE process_id=$1', [`srv-${run}`]);
    }
  });
});
