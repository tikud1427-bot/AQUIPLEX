/**
 * Phases 4 + 5 on live Postgres, through the production paths.
 *
 *   turns (scripted extraction only) → canonical claims → outbox → durable
 *   `proactive.evaluate.v1` (production handler) → triggers + policy →
 *   intervention + evidence links + proposed action run → delivered ONCE into
 *   the production prompt (prepareTurn) → user response → learning →
 *   approval seam → `action.execute.v1` (production handler) → outcome.
 *
 * G1 fail-closed (gate off → nothing), G2 idempotency (re-evaluation, duplicate
 * job delivery, double delivery), G3 owner isolation, G4 purge, G5 audit rows,
 * G6 bounds (step budget / approval), G7 production wiring (handler table,
 * outbox dispatcher, prepareTurn).
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.AQUA_E6 = 'on';
process.env.AQUA_CONTEXT_V2 = 'on';
process.env.AQUA_RETRIEVAL_V3 = 'on';
process.env.AQUA_SELF_ENTITY = 'on';
process.env.AQUA_CANONICAL_READ = 'on';
process.env.AQUA_PROACTIVE = 'on';

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
const Proactive = await import('./index.js');
const { prepareTurn } = await import('../../routes/chat.js');
const { createContext } = await import('../../core/observability.js');
const { HANDLERS, dispatchReflections } = await import('../../core/jobs/workerRuntime.js');
const { complete } = await import('../../core/jobs/jobQueue.js');
const Actions = await import('../actions/executor.js');
const ActionRuns = await import('../actions/repository.js');
const { purgeOwnerData } = await import('../../account/accountPurge.js');

const USER = `pro-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OWNER = `user:${USER}`;
const KINDS = ['claim.embedding.v1', 'claim.reflection.v1', 'claim.contradiction.v1', 'proactive.evaluate.v1', 'action.execute.v1'];

// A deadline 6 days out, written the way users say it ("October 12").
const due = new Date(Date.now() + 6 * 86_400_000);
const DUE = due.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
const claim = (subject, predicate, object, statementText, extra = {}) => ({
  subject, predicate, object, statementText, polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9, ...extra,
});
const SCRIPT = new Map([
  [`The iOS launch is due ${DUE}`, [claim('iOS launch', 'deadline_for', { literal: DUE }, `The iOS launch is due ${DUE}`)]],
  ['The payment integration is blocking the iOS launch', [claim('payment integration', 'blocks', { entity: 'iOS launch' }, 'The payment integration is blocking the iOS launch')]],
  ['Rohan owns the payment integration', [claim('Rohan', 'owns', { entity: 'payment integration' }, 'Rohan owns the payment integration')]],
  ['I work at Acme', [claim('I', 'works_at', { entity: 'Acme' }, 'I work at Acme')]],
  ["I don't work at Acme", [claim('I', 'works_at', { entity: 'Acme' }, "I don't work at Acme", { polarity: 'negated' })]],
]);
const callModel = async (arg = {}) => {
  const seen = JSON.stringify(arg);
  const key = [...SCRIPT.keys()].sort((a, b) => b.length - a.length).find(k => seen.includes(k));
  return { text: JSON.stringify({ claims: key ? SCRIPT.get(key) : [] }), model: 'scripted/proactive' };
};
let turn = 0;
const say = text => Brain.understandTurn({ ownerId: OWNER, conversationId: 'c-pro', turn: ++turn, userMessage: `${text}.`, callModel });
async function drain({ twice = false } = {}) {
  const p = await getPool();
  for (let i = 0; i < 150; i++) {
    await dispatchReflections({ limit: 200 });
    const { rows } = await p.query(
      `UPDATE aqua_jobs SET state='running', attempts=attempts+1, claimed_by='pro-test', updated_at=now()
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
      if (twice) await HANDLERS[r.kind](job);
      await complete(r.job_id);
    }
  }
  throw new Error('drain did not settle');
}
const q = async (sql, params) => (await (await getPool()).query(sql, params)).rows;
const count = async (table, where = '') => (await q(`SELECT count(*)::int AS n FROM ${table} WHERE owner_id=$1 ${where}`, [OWNER]))[0].n;
async function ask(question) {
  const conv = `ask-${crypto.randomUUID()}`;
  const requestId = crypto.randomUUID();
  return prepareTurn({ userMessage: question, conversationId: conv, userId: USER, ctx: createContext({ conversationId: conv, requestId }), requestId, skipReasoningPass: true });
}

describe('Phase 4/5 — proactive intelligence and bounded action on live Postgres', { skip }, () => {
  after(async () => {
    __clearEmbedderForTests();
    for (const k of ['AQUA_CANONICAL_READ', 'AQUA_PROACTIVE']) delete process.env[k];
    if (!LIVE) return;
    await purgeOwnerData({ userId: USER });
    await closePool();
  });

  test('G1 fail-closed: with AQUA_PROACTIVE off the world changes and NOTHING is evaluated or raised', async () => {
    process.env.AQUA_PROACTIVE = 'off';
    await say(`The iOS launch is due ${DUE}`);
    await drain();
    assert.equal(await count('aqua_interventions'), 0);
    assert.equal(await count('aqua_jobs', `AND kind='proactive.evaluate.v1'`), 0, 'no evaluation job when the gate is off');
    assert.equal(await Proactive.proactiveDirectiveForTurn(OWNER), '');
    process.env.AQUA_PROACTIVE = 'on';
  });

  test('SCENARIO 9 (G7): a world change reaches the durable evaluation job → a blocked deadline fires, with evidence and a proposed plan', async () => {
    await say('The payment integration is blocking the iOS launch');
    await say('Rohan owns the payment integration');
    await drain();
    assert.ok(await count('aqua_jobs', `AND kind='proactive.evaluate.v1'`) >= 1, 'the outbox dispatcher never enqueued an evaluation');
    const [iv] = await q(`SELECT * FROM aqua_interventions WHERE owner_id=$1 AND trigger_type='deadline_at_risk'`, [OWNER]);
    assert.ok(iv, 'no deadline_at_risk intervention');
    assert.equal(iv.status, 'proposed');
    assert.equal(iv.severity, 'high');
    assert.match(iv.message, /payment integration \(owned by Rohan\) is still blocking it/);
    assert.equal(await count('aqua_intervention_evidence', `AND intervention_id='${iv.intervention_id}'`), 3, 'deadline + blocker + owner claims are the evidence');
    const [run] = await q(`SELECT * FROM aqua_action_runs WHERE owner_id=$1 AND intervention_id=$2`, [OWNER, iv.intervention_id]);
    assert.equal(run.kind, 'draft_message');
    assert.equal(run.status, 'proposed', 'a plan waits for approval');
  });

  test('G2 idempotency: re-evaluation and duplicate job delivery write nothing new', async () => {
    const before = [await count('aqua_interventions'), await count('aqua_action_runs'), await count('aqua_intervention_evidence')];
    await Proactive.evaluateOwner(OWNER);
    await HANDLERS['proactive.evaluate.v1']({ ownerId: OWNER, payload: {} });
    await HANDLERS['proactive.evaluate.v1']({ ownerId: OWNER, payload: {} });
    assert.deepEqual([await count('aqua_interventions'), await count('aqua_action_runs'), await count('aqua_intervention_evidence')], before);
  });

  test('delivery: the production prompt raises it ONCE; the next turn does not repeat it', async () => {
    const first = await ask('Can you help me plan my week?');
    assert.match(first.systemPrompt, /PROACTIVE NOTE/);
    assert.match(first.systemPrompt, /owned by Rohan/);
    const second = await ask('And what about next week?');
    assert.doesNotMatch(second.systemPrompt, /PROACTIVE NOTE/, 'delivered twice');
    const [iv] = await q(`SELECT status, delivery_status, delivered_at FROM aqua_interventions WHERE owner_id=$1 AND trigger_type='deadline_at_risk'`, [OWNER]);
    assert.equal(iv.status, 'delivered');
    assert.ok(iv.delivered_at);
  });

  test('APPROVAL SEAM (Phase 5): an unapproved run never executes; approval → bounded execution → outcome on the intervention', async () => {
    const [run] = await q(`SELECT run_id, intervention_id FROM aqua_action_runs WHERE owner_id=$1 AND kind='draft_message'`, [OWNER]);
    const premature = await Actions.runActionJob({ ownerId: OWNER, payload: { runId: run.run_id } });
    assert.equal(premature.skipped, 'proposed', 'a proposed run executed without approval');
    const ok = await Actions.approve(OWNER, run.run_id);
    assert.equal(ok.ok, true);
    await drain();
    const done = await ActionRuns.getRun(OWNER, run.run_id);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.result.steps.length, 1);
    assert.equal(done.result.steps[0].out.sent, false, 'a draft is never sent by Aqua');
    assert.match(done.result.steps[0].out.draft.body, /^Hi Rohan/);
    const [iv] = await q(`SELECT outcome FROM aqua_interventions WHERE owner_id=$1 AND intervention_id=$2`, [OWNER, run.intervention_id]);
    assert.equal(iv.outcome.action.status, 'succeeded');
    const audit = (await q(`SELECT event_type FROM aqua_outbox WHERE owner_id=$1 AND aggregate_id=$2 ORDER BY outbox_id`, [OWNER, run.run_id])).map(r => r.event_type);
    assert.deepEqual(audit, ['action.proposed', 'action.approved', 'action.running', 'action.succeeded'], 'every transition audited (G5)');
    const again = await Actions.approve(OWNER, run.run_id);
    assert.equal(again.code, 'NOT_PROPOSED', 'approval is not replayable into a second execution');
  });

  test('LEARNING: the user\'s response is recorded and read back by the policy', async () => {
    const [iv] = await q(`SELECT intervention_id FROM aqua_interventions WHERE owner_id=$1 AND trigger_type='deadline_at_risk'`, [OWNER]);
    const r = await Proactive.respondToIntervention(OWNER, iv.intervention_id, 'dismissed');
    assert.equal(r.status, 'dismissed');
    const replay = await Proactive.respondToIntervention(OWNER, iv.intervention_id, 'dismissed');
    assert.equal(replay.replayed, true);
    const hist = await Proactive.proactiveRepository.loadHistory(OWNER);
    assert.ok(hist.some(h => h.userResponse === 'dismissed'));
    const stats = await Proactive.proactiveRepository.interventionStats(OWNER);
    assert.equal(stats.dismissalRate, 1);
  });

  test('CONTRADICTION → user choice → canonical lifecycle path (actor user); a stale plan cannot act', async () => {
    await say('I work at Acme');
    await drain();
    await say("I don't work at Acme");
    await drain();
    const disputed = await q(`SELECT claim_id, polarity FROM aqua_claims WHERE owner_id=$1 AND predicate='works_at' AND state='disputed'`, [OWNER]);
    assert.equal(disputed.length, 2, 'the unmarked polarity flip should be disputed (E9 policy)');
    const ev = await Proactive.evaluateOwner(OWNER, { now: new Date(Date.now() + 31 * 60_000) });
    assert.ok(ev.interventions.some(i => i.type === 'contradiction_unresolved' && i.fired));
    const [run] = await q(`SELECT run_id FROM aqua_action_runs WHERE owner_id=$1 AND kind='resolve_contradiction'`, [OWNER]);
    const noChoice = await Actions.approve(OWNER, run.run_id);
    assert.equal(noChoice.code, 'CHOICE_REQUIRED');
    const keep = disputed.find(c => c.polarity === 'negated').claim_id;
    assert.equal((await Actions.approve(OWNER, run.run_id, { choice: keep })).ok, true);
    await drain();
    const states = Object.fromEntries((await q(`SELECT claim_id, state, superseded_by FROM aqua_claims WHERE owner_id=$1 AND claim_id = ANY($2::uuid[])`, [OWNER, disputed.map(c => c.claim_id)])).map(r => [r.claim_id, r]));
    assert.equal(states[keep].state, 'active');
    const other = disputed.find(c => c.claim_id !== keep).claim_id;
    assert.equal(states[other].state, 'superseded');
    assert.equal(states[other].superseded_by, keep);
    const tr = await q(`SELECT actor, reason FROM aqua_lifecycle_transitions WHERE owner_id=$1 AND target_id=$2 AND to_state='superseded'`, [OWNER, other]);
    assert.ok(tr.some(t => t.actor === 'user' && t.reason === 'user-resolved-contradiction'), 'the change went through the audited lifecycle path as the user');
  });

  test('ACTIONS: a re-delivered execution job is a no-op; a plan whose world changed FAILS (audited), never acts', async () => {
    const [done] = await q(`SELECT run_id FROM aqua_action_runs WHERE owner_id=$1 AND kind='resolve_contradiction'`, [OWNER]);
    const before = await count('aqua_lifecycle_transitions');
    assert.equal((await Actions.runActionJob({ ownerId: OWNER, payload: { runId: done.run_id } })).skipped, 'succeeded');
    assert.equal(await count('aqua_lifecycle_transitions'), before, 'a duplicate execution touched the World Model');
    // A stale plan: approve a contradiction plan, then the world changes before it runs.
    await say('I work at Acme');
    await drain();
    await say("I don't work at Acme");
    await drain();
    const fresh = await q(`SELECT claim_id, polarity FROM aqua_claims WHERE owner_id=$1 AND predicate='works_at' AND state='disputed'`, [OWNER]);
    assert.equal(fresh.length, 2, `expected a fresh dispute pair, got ${fresh.length}`);
    {
      // (the policy rightly suppresses a second raise on the same cooldown key,
      // so the plan is proposed directly through the planner)
      const { proposeAction } = await import('../actions/planner.js');
      const plan = proposeAction({ type: 'contradiction_unresolved', subjectLabel: 'you', evidenceClaimIds: fresh.map(c => c.claim_id) });
      await ActionRuns.proposeRun(OWNER, { plan, expiresAt: new Date(Date.now() + 86_400_000) });
      const runs = await q(`SELECT run_id FROM aqua_action_runs WHERE owner_id=$1 AND kind='resolve_contradiction' AND status='proposed'`, [OWNER]);
      assert.equal(runs.length, 1, 'expected a second contradiction plan');
      const keep = fresh[0].claim_id;
      assert.equal((await Actions.approve(OWNER, runs[0].run_id, { choice: keep })).ok, true);
      // the user settles it another way before the job runs
      const { transition } = await import('../../core/worldModel/worldModelRepository.js');
      await transition({ ownerId: OWNER, actor: 'user', targetKind: 'claim', targetId: fresh[1].claim_id, toState: 'active', reason: 'test' });
      await transition({ ownerId: OWNER, actor: 'user', targetKind: 'claim', targetId: keep, toState: 'superseded', supersededBy: fresh[1].claim_id, reason: 'test' });
      const r = await Actions.runActionJob({ ownerId: OWNER, payload: { runId: runs[0].run_id } });
      assert.equal(r.failed, true);
      const run = await ActionRuns.getRun(OWNER, runs[0].run_id);
      assert.equal(run.status, 'failed');
      assert.match(run.error, /world changed/);
      const audit = (await q(`SELECT event_type FROM aqua_outbox WHERE owner_id=$1 AND aggregate_id=$2`, [OWNER, run.runId])).map(x => x.event_type);
      assert.ok(audit.includes('action.failed'));
    }
  });

  test('PRODUCT instrumentation: usefulness / dismissal / false-intervention rates over DELIVERED interventions', async () => {
    const s = await Proactive.proactiveRepository.interventionStats(OWNER);
    assert.ok(s.product.delivered >= 1);
    assert.equal(s.product.dismissal, Number((1 / s.product.delivered).toFixed(4)));
    assert.match(s.product.source, /real user responses/);
  });

  test('G3 owner isolation: another owner sees, answers and approves nothing', async () => {
    const otherOwner = `${OWNER}-other`;
    const ev = await Proactive.evaluateOwner(otherOwner);
    assert.equal(ev.candidates, 0);
    const [iv] = await q(`SELECT intervention_id FROM aqua_interventions WHERE owner_id=$1 LIMIT 1`, [OWNER]);
    assert.equal(await Proactive.respondToIntervention(otherOwner, iv.intervention_id, 'accepted'), null);
    const [run] = await q(`SELECT run_id FROM aqua_action_runs WHERE owner_id=$1 LIMIT 1`, [OWNER]);
    assert.equal((await Actions.approve(otherOwner, run.run_id)).code, 'NOT_FOUND');
    assert.equal((await Proactive.proactiveRepository.listInterventions(otherOwner)).length, 0);
  });

  test('RESTART: state survives a fresh pool (delivered stays delivered, nothing re-raised)', async () => {
    await closePool();
    assert.equal(await Proactive.proactiveDirectiveForTurn(OWNER), '');
    assert.ok((await Proactive.proactiveRepository.listInterventions(OWNER)).length >= 2);
  });

  test('G4 purge: interventions, evidence links, prefs and action runs are gone; claims too', async () => {
    await Proactive.proactiveRepository.savePrefs(OWNER, { minSeverity: 'high' });
    const report = await purgeOwnerData({ userId: USER });
    assert.deepEqual(report.errors ?? [], []);
    for (const t of ['aqua_interventions', 'aqua_intervention_evidence', 'aqua_proactive_prefs', 'aqua_action_runs', 'aqua_claims']) {
      assert.equal(await count(t), 0, `${t} not purged`);
    }
  });
});
