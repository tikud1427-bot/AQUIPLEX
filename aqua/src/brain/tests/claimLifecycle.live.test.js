/**
 * Changing facts on a REAL Postgres through the production path:
 *   understandTurn (S0–S9, registry-derived single-valued sets)
 *   → claim.contradiction.detected in the transactional outbox
 *   → runClaimContradictionJob (real policy, real transition())
 *   → the next context shows the current value only; history is kept.
 * The extraction model is the only stand-in (scripted), as in the loop test.
 * Without AQUA_TEST_DATABASE_URL every test SKIPS visibly.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.AQUA_E6 = 'on';
process.env.AQUA_CONTEXT_V2 = 'on';
process.env.AQUA_RETRIEVAL_V3 = 'on';
process.env.AQUA_SELF_ENTITY = 'on';

const { isConfigured, getPool, closePool } = await import('../../core/db/pool.js');
const LIVE = isConfigured();
const skip = LIVE ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';

const Brain = await import('../index.js');
const { runClaimContradictionJob } = await import('../reflectionV3/contradictionWorker.js');

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OWNER = `life-a-${run}`;
const OTHER = `life-b-${run}`;

const claim = (subject, predicate, object, statementText, extra = {}) => ({
  subject, predicate, object, statementText,
  polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9, ...extra,
});
const SCRIPT = new Map([
  ['I live in Berlin', [claim('I', 'located_in', { entity: 'Berlin' }, 'I live in Berlin')]],
  ['I moved to Paris', [claim('I', 'located_in', { entity: 'Paris' }, 'I moved to Paris')]],
  ['Now I live in Rome', [claim('I', 'located_in', { entity: 'Rome' }, 'Now I live in Rome')]],
  ['I use Postgres', [claim('I', 'uses', { entity: 'Postgres' }, 'I use Postgres')]],
  ['I use Redis', [claim('I', 'uses', { entity: 'Redis' }, 'I use Redis')]],
  ['Lena owns the billing service', [claim('Lena', 'owns', { entity: 'billing service' }, 'Lena owns the billing service')]],
  ['Omar owns the billing service now', [claim('Omar', 'owns', { entity: 'billing service' }, 'Omar owns the billing service now')]],
]);
const callModel = async (arg = {}) => {
  const seen = JSON.stringify(arg);
  const key = [...SCRIPT.keys()].sort((a, b) => b.length - a.length).find(k => seen.includes(k));
  return { text: JSON.stringify({ claims: key ? SCRIPT.get(key) : [] }), model: 'scripted/lifecycle' };
};

let turn = 0;
const say = (ownerId, s) => Brain.understandTurn({ ownerId, conversationId: `c-${run}`, turn: ++turn, userMessage: `${s}.`, callModel });
const empty = () => ({ items: [], block: '', stats: {} });
const ask = async (ownerId, q) => (await Brain.assembleContextAsync(ownerId, q, empty, { limit: 8 })).block ?? '';
const pool = async () => getPool();

/** Run every pending contradiction event for this owner through the production worker. */
async function settle(ownerId) {
  const p = await pool();
  const { rows } = await p.query(
    `SELECT outbox_id, payload FROM aqua_outbox WHERE owner_id=$1 AND event_type='claim.contradiction.detected' ORDER BY outbox_id`, [ownerId]);
  const results = [];
  for (const r of rows) results.push(await runClaimContradictionJob({ ownerId, payload: r.payload }));
  return results;
}
const rowsOf = async (ownerId, predicate) => (await (await pool()).query(
  `SELECT claim_id, statement_text, state, superseded_by, valid_to FROM aqua_claims
    WHERE owner_id=$1 AND predicate=$2 ORDER BY asserted_at, claim_id`, [ownerId, predicate])).rows;

after(async () => { if (LIVE) await closePool(); });

test('claim lifecycle: live Postgres is available', { skip }, () => { assert.ok(LIVE); });

describe('claim lifecycle on live Postgres', { skip }, () => {
  test('A → B → C: each new location retires the previous one, history kept with a closed window', async () => {
    await say(OWNER, 'I live in Berlin');
    await say(OWNER, 'I moved to Paris');
    await settle(OWNER);
    await say(OWNER, 'Now I live in Rome');
    const results = await settle(OWNER);
    assert.ok(results.every(r => r.ok), `a contradiction job failed: ${JSON.stringify(results)}`);

    const rows = await rowsOf(OWNER, 'located_in');
    const by = Object.fromEntries(rows.map(r => [r.statement_text, r]));
    assert.equal(by['I live in Rome'] ?? by['Now I live in Rome'] ? 'ok' : 'missing', 'ok');
    const rome = by['Now I live in Rome'];
    assert.equal(rome.state, 'active');
    assert.equal(by['I moved to Paris'].state, 'superseded');
    assert.equal(by['I moved to Paris'].superseded_by, rome.claim_id);
    assert.equal(by['I live in Berlin'].state, 'superseded');
    assert.ok(by['I live in Berlin'].valid_to, 'a superseded claim must carry its closing boundary');
    assert.equal(rows.length, 3, 'history must be kept, never deleted (L5)');

    const block = await ask(OWNER, 'Where do I live?');
    assert.match(block, /Now I live in Rome/);
    assert.doesNotMatch(block, /• I live in Berlin|• I moved to Paris/, `a retired location is presented as current:\n${block}`);
  });

  test('a past-tense question sees history, explicitly marked as no longer current', async () => {
    const block = await ask(OWNER, 'Where did I live before?');
    assert.match(block, /I moved to Paris[^\n]*no longer current/, `history missing or unmarked:\n${block}`);
    assert.doesNotMatch(block, /Now I live in Rome[^\n]*no longer current/, 'the current value was marked as past');
  });

  test('multi-valued: a second tool does not retire the first', async () => {
    await say(OWNER, 'I use Postgres');
    await say(OWNER, 'I use Redis');
    await settle(OWNER);
    const states = (await rowsOf(OWNER, 'uses')).map(r => r.state);
    assert.deepEqual(states, ['active', 'active']);
  });

  test('one-per-object: a new owner of the same thing retires the old owner', async () => {
    await say(OWNER, 'Lena owns the billing service');
    await say(OWNER, 'Omar owns the billing service now');
    await settle(OWNER);
    const rows = await rowsOf(OWNER, 'owns');
    const lena = rows.find(r => r.statement_text.startsWith('Lena'));
    const omar = rows.find(r => r.statement_text.startsWith('Omar'));
    assert.equal(lena.state, 'superseded');
    assert.equal(lena.superseded_by, omar.claim_id);
    assert.equal(omar.state, 'active');
  });

  test('replaying the worker is idempotent: no state changes, no throw', async () => {
    const before = await rowsOf(OWNER, 'located_in');
    const results = await settle(OWNER);
    assert.ok(results.every(r => r.ok), JSON.stringify(results));
    assert.deepEqual(await rowsOf(OWNER, 'located_in'), before);
  });

  test('returning to an old value revives it as a new current claim (the same sentence twice)', async () => {
    await say(OWNER, 'I live in Berlin');
    const results = await settle(OWNER);
    assert.ok(results.every(r => r.ok), JSON.stringify(results));
    const current = (await rowsOf(OWNER, 'located_in')).filter(r => r.state === 'active');
    assert.equal(current.length, 1, `exactly one current location: ${JSON.stringify(current)}`);
    assert.equal(current[0].statement_text, 'I live in Berlin');
  });

  test('owner isolation: another owner\'s changes never touch this owner', async () => {
    await say(OTHER, 'I live in Berlin');
    await say(OTHER, 'I moved to Paris');
    await settle(OTHER);
    const mine = (await rowsOf(OWNER, 'located_in')).filter(r => r.state === 'active');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].statement_text, 'I live in Berlin');
    const theirs = (await rowsOf(OTHER, 'located_in')).filter(r => r.state === 'active');
    assert.deepEqual(theirs.map(r => r.statement_text), ['I moved to Paris']);
  });
});
