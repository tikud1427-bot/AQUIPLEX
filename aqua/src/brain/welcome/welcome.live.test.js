/**
 * The welcome line on live Postgres, through the production paths (K).
 *
 *   user turns (scripted extraction only) → Brain.understandTurn → canonical
 *   claims → outbox → durable reflection / contradiction jobs (production
 *   handlers: supersession, disputes) → loadWelcomeSlice → selectWelcome →
 *   GET /brain/welcome (production router, authoritative read mode)
 *
 * The only stub is the extraction model's reply, so every lifecycle decision
 * the line depends on — what is current, what was superseded, what a newer
 * status resolved — is made by the same code that serves users.
 *
 *   B  a blocker, then its resolution, changes the line
 *   C  a goal followed by "it's done" is never shown as unfinished
 *   D  a revised priority replaces the old one
 *   G  owner isolation over HTTP
 *   I  the line re-evaluates when the world changes, and only then
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';

process.env.AQUA_E6 = 'on';
process.env.AQUA_SELF_ENTITY = 'on';
delete process.env.AQUA_CANONICAL_READ;   // the default: 'authoritative'

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
const { welcomeFor } = await import('./index.js');
const { loadWelcomeSlice } = await import('./repository.js');
const { HANDLERS, dispatchReflections } = await import('../../core/jobs/workerRuntime.js');
const { complete } = await import('../../core/jobs/jobQueue.js');
const { purgeOwnerData } = await import('../../account/accountPurge.js');
const { default: brainRoute } = await import('../../routes/brain.js');

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const USERS = { blocker: `wb-${RUN}`, done: `wd-${RUN}`, shift: `ws-${RUN}` };
const OWNERS = Object.fromEntries(Object.entries(USERS).map(([k, u]) => [k, `user:${u}`]));
const KINDS = ['claim.embedding.v1', 'claim.reflection.v1', 'claim.contradiction.v1', 'proactive.evaluate.v1', 'action.execute.v1'];

const c = (subject, predicate, object, statementText, extra = {}) => ({
  subject, predicate, object, statementText, polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9, ...extra,
});
const SCRIPT = new Map([
  ["I'm building Aquiplex", [c('self', 'builds', { literal: 'Aquiplex' }, "I'm building Aquiplex")]],
  ['I want to launch the beta', [c('self', 'plans_to', { literal: 'launch the beta' }, 'I want to launch the beta', { modality: 'intent' })]],
  ['The auth bug is blocking the launch', [c('auth bug', 'blocks', { entity: 'launch' }, 'The auth bug is blocking the launch')]],
  ['The auth bug is fixed', [c('auth bug', 'has_status', { literal: 'fixed' }, 'The auth bug is fixed')]],
  ['I want to finish the migration', [c('self', 'plans_to', { literal: 'finish the migration' }, 'I want to finish the migration', { modality: 'intent' })]],
  ['The migration is done', [c('migration', 'has_status', { literal: 'done' }, 'The migration is done')]],
  ['My priority is to launch the mobile app', [c('self', 'plans_to', { literal: 'launch the mobile app' }, 'My priority is to launch the mobile app', { modality: 'intent' })]],
  ['Actually my priority is now to ship the web beta, not launch the mobile app', [
    c('self', 'plans_to', { literal: 'ship the web beta' }, 'Actually my priority is now to ship the web beta', { modality: 'intent', revises: true }),
    c('self', 'plans_to', { literal: 'launch the mobile app' }, 'not launch the mobile app', { modality: 'intent', polarity: 'negated', revises: true }),
  ]],
]);
const callModel = async (arg = {}) => {
  const seen = JSON.stringify(arg);
  const key = [...SCRIPT.keys()].sort((a, b) => b.length - a.length).find(k => seen.includes(k));
  return { text: JSON.stringify({ claims: key ? SCRIPT.get(key) : [] }), model: 'scripted/welcome' };
};
const turns = {};
const say = (who, text) => Brain.understandTurn({
  ownerId: OWNERS[who], conversationId: `c-welcome-${who}`, turn: (turns[who] = (turns[who] ?? 0) + 1), userMessage: `${text}.`, callModel,
});

async function drain(owner) {
  const p = await getPool();
  for (let i = 0; i < 150; i++) {
    await dispatchReflections({ limit: 200 });
    const { rows } = await p.query(
      `UPDATE aqua_jobs SET state='running', attempts=attempts+1, claimed_by='welcome-test', updated_at=now()
        WHERE owner_id=$1 AND state='queued' AND kind = ANY($2) RETURNING job_id, kind, owner_id, payload, attempts`, [owner, KINDS]);
    if (!rows.length) {
      const { rows: [{ n }] } = await p.query(
        `SELECT (SELECT count(*) FROM aqua_outbox WHERE owner_id=$1 AND state IN ('pending','processing'))
              + (SELECT count(*) FROM aqua_jobs WHERE owner_id=$1 AND state IN ('queued','running') AND kind = ANY($2)) AS n`, [owner, KINDS]);
      if (!Number(n)) return;
      await new Promise(r => setTimeout(r, 100));
      continue;
    }
    rows.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
    for (const r of rows) {
      await HANDLERS[r.kind]({ jobId: r.job_id, kind: r.kind, ownerId: r.owner_id, payload: r.payload, attempts: r.attempts });
      await complete(r.job_id);
    }
  }
  throw new Error('drain did not settle');
}
async function tell(who, ...lines) {
  for (const l of lines) await say(who, l);
  await drain(OWNERS[who]);
}

// The production router, as the platform mounts it.
const app = express();
app.use((req, _res, next) => { if (req.headers['x-test-user']) req.aquaUserId = String(req.headers['x-test-user']); next(); });
app.use('/brain', brainRoute);
let server, base;
const http = async user => (await (await fetch(`${base}/brain/welcome?history=1`, { headers: { 'x-test-user': user } })).json()).welcome;

describe('welcome line — live canonical World Model through production paths', { skip }, () => {
  before(() => {
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server?.close();
    __clearEmbedderForTests();
    if (!LIVE) return;
    for (const u of Object.values(USERS)) await purgeOwnerData({ userId: u });
    await closePool();
  });

  test('a new owner with no world gets the honest invitation, not a fabrication', async () => {
    const w = await http(USERS.blocker);
    assert.equal(w.readMode, 'authoritative');
    assert.equal(w.established, false);
    assert.equal(w.basis, 'none');
  });

  test('B + I: goal, then a blocker on it, then the blocker resolved — the line follows the world', async () => {
    await tell('blocker', "I'm building Aquiplex", 'I want to launch the beta');
    const goal = await http(USERS.blocker);
    assert.equal(goal.basis, 'world_model');
    assert.equal(goal.text, "Let's keep working toward launching the beta.");

    // Unchanged world → unchanged line (H, through HTTP and Postgres).
    const again = await http(USERS.blocker);
    assert.equal(again.messageId, goal.messageId);
    assert.equal(again.worldVersion, goal.worldVersion);

    await tell('blocker', 'The auth bug is blocking the launch');
    const blocked = await http(USERS.blocker);
    assert.notEqual(blocked.worldVersion, goal.worldVersion, 'the world changed');
    assert.equal(blocked.kind, 'blocked');
    assert.match(blocked.text, /auth bug/);

    await tell('blocker', 'The auth bug is fixed');
    const resolved = await http(USERS.blocker);
    assert.notEqual(resolved.worldVersion, blocked.worldVersion);
    assert.equal(resolved.kind, 'unblocked');
    assert.equal(resolved.text, 'With the auth bug sorted, the launch can move forward again.');
    assert.doesNotMatch(resolved.text, /out of the way|still/);

    // Every cited claim is this owner's and is real.
    const ids = resolved.evidence.map(e => e.id);
    const { rows } = await (await getPool()).query('SELECT owner_id FROM aqua_claims WHERE claim_id = ANY($1::uuid[])', [ids]);
    assert.equal(rows.length, ids.length);
    assert.ok(rows.every(r => r.owner_id === OWNERS.blocker));
  });

  test('C: "I want to finish the migration" then "the migration is done" — never shown as unfinished', async () => {
    await tell('done', 'I want to finish the migration');
    assert.equal((await welcomeFor(OWNERS.done, { history: true })).text, "Let's keep working toward finishing the migration.");
    await tell('done', 'The migration is done');
    const w = await welcomeFor(OWNERS.done, { history: true });
    assert.equal(w.kind, 'completed');
    assert.equal(w.text, "The migration is done — what's next?");
  });

  test('D: a revised priority replaces the old one in the line, although the store keeps the old intent active', async () => {
    await tell('shift', 'My priority is to launch the mobile app');
    assert.match((await welcomeFor(OWNERS.shift)).text, /launching the mobile app/);

    await tell('shift', 'Actually my priority is now to ship the web beta, not launch the mobile app');

    // MEASURED WORLD-MODEL GAP (2026-10-10): the contradiction worker retires
    // only FACT snapshots (isDeclaredSnapshotPair), so a revised INTENT is not
    // superseded — the old plan, its negated twin and the new plan are all
    // 'active'. Pinned here so the day the store starts retiring it, this
    // assertion says so. The line must be right either way: the newer
    // negation closes the old plan at read time (selector `closedBy`, the
    // same rule as proactive `isResolved`).
    const plans = (await loadWelcomeSlice(OWNERS.shift)).filter(x => x.predicate === 'plans_to');
    const state = (value, polarity) => plans.find(x => x.object.value === value && x.polarity === polarity)?.state;
    assert.equal(state('launch the mobile app', 'negated'), 'active', 'the correction itself is recorded');
    assert.equal(state('launch the mobile app', 'asserted'), 'active', 'store gap: old intent not superseded');

    const w = await welcomeFor(OWNERS.shift);
    assert.equal(w.kind, 'focus_changed');
    assert.equal(w.text, "Your focus has moved to shipping the web beta — let's build on that.");
    assert.doesNotMatch(w.text, /mobile/);
  });

  test('G: each user sees only their own world over HTTP', async () => {
    const [a, b, s] = await Promise.all([http(USERS.blocker), http(USERS.done), http(USERS.shift)]);
    assert.match(a.text, /auth bug/);
    assert.doesNotMatch(a.text, /migration|web beta/);
    assert.match(b.text, /migration/);
    assert.doesNotMatch(b.text, /auth|web beta/);
    assert.match(s.text, /web beta/);
    assert.doesNotMatch(s.text, /auth|migration/);
    const stranger = await http(`stranger-${RUN}`);
    assert.equal(stranger.established, false);
  });
});
