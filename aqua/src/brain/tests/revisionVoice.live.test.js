/**
 * The revision voice over the CANONICAL World Model, on a REAL Postgres,
 * through the production path:
 *   understandTurn → S8 contradiction → runClaimContradictionJob (real policy)
 *   → aqua_lifecycle_transitions → Brain.revisionDirectiveForTurn
 *   → aqua_revision_voice_state (compare-and-set watermark).
 * Only extraction is scripted. Skips visibly without AQUA_TEST_DATABASE_URL.
 *
 * What it proves (the L14 evaluation for AQUA_REVISION_VOICE):
 *   correctness     a policy supersession from an earlier conversation is raised
 *   provenance      the directive quotes exactly the stored statements, older first
 *   no invention    nothing in quotes that is not a stored statement
 *   correction      a user correction is never raised back
 *   echo            a change made in THIS conversation is not raised
 *   contradiction   an unsettled dispute is raised as a question of which holds
 *   idempotency     raised once; concurrent turns raise it exactly once
 *   suitability     a working turn neither raises nor burns it
 *   isolation       another owner sees nothing
 *   purge           the watermark row is erased with the owner
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.AQUA_E6 = 'on';
process.env.AQUA_SELF_ENTITY = 'on';
process.env.AQUA_REVISION_VOICE = 'on';

const { isConfigured, getPool, closePool } = await import('../../core/db/pool.js');
const LIVE = isConfigured();
const skip = LIVE ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';

const Brain = await import('../index.js');
const { runClaimContradictionJob } = await import('../reflectionV3/contradictionWorker.js');
const repo = await import('../../core/worldModel/worldModelRepository.js');
const readModel = await import('../../core/worldModel/canonicalReadModel.js');

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const owner = name => `voice-${name}-${run}`;
const claim = (subject, predicate, object, statementText, extra = {}) => ({
  subject, predicate, object, statementText,
  polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9, ...extra,
});
const SCRIPT = new Map([
  ['I live in Berlin', [claim('I', 'located_in', { entity: 'Berlin' }, 'I live in Berlin')]],
  ['I moved to Paris', [claim('I', 'located_in', { entity: 'Paris' }, 'I moved to Paris')]],
  ['I use Redis', [claim('I', 'uses', { entity: 'Redis' }, 'I use Redis')]],
  ['I do not use Redis', [claim('I', 'uses', { entity: 'Redis' }, 'I do not use Redis', { polarity: 'negated' })]],
]);
const callModel = async (arg = {}) => {
  const seen = JSON.stringify(arg);
  const key = [...SCRIPT.keys()].sort((a, b) => b.length - a.length).find(k => seen.includes(k));
  return { text: JSON.stringify({ claims: key ? SCRIPT.get(key) : [] }), model: 'scripted/revision-voice' };
};
let turn = 0;
const say = (ownerId, conv, s) => Brain.understandTurn({ ownerId, conversationId: `${conv}-${run}`, turn: ++turn, userMessage: `${s}.`, callModel });
const voice = (ownerId, conv, taskType = 'conversation') =>
  Brain.revisionDirectiveForTurn(ownerId, { taskType, conversationId: `${conv}-${run}` });

async function settle(ownerId) {
  const p = await getPool();
  const { rows } = await p.query(
    `SELECT payload FROM aqua_outbox WHERE owner_id=$1 AND event_type='claim.contradiction.detected' ORDER BY outbox_id`, [ownerId]);
  const out = [];
  for (const r of rows) out.push(await runClaimContradictionJob({ ownerId, payload: r.payload }));
  assert.ok(out.length && out.every(r => r.ok), `contradiction jobs: ${JSON.stringify(out)}`);
  return out;
}
const statements = async ownerId => new Set((await (await getPool()).query(
  'SELECT statement_text FROM aqua_claims WHERE owner_id=$1', [ownerId])).rows.map(r => r.statement_text));
const quoted = d => [...d.matchAll(/"([^"]+)"/g)].map(m => m[1]);

/** Berlin in conversation 1, Paris in conversation 2, settled by the real policy. */
async function moved(ownerId) {
  await say(ownerId, 'one', 'I live in Berlin');
  await say(ownerId, 'two', 'I moved to Paris');
  await settle(ownerId);
}

after(async () => { if (LIVE) await closePool(); });
test('revision voice: live Postgres is available', { skip }, () => { assert.ok(LIVE); });

describe('canonical revision voice on live Postgres', { skip }, () => {
  test('a supersession from an earlier conversation is raised once, quoting only stored words, older first', async () => {
    const A = owner('moved');
    await moved(A);
    const d = await voice(A, 'three');
    assert.ok(d, 'nothing raised');
    const q = quoted(d);
    assert.deepEqual(q, ['I live in Berlin', 'I moved to Paris'], d);
    const stored = await statements(A);
    for (const s of q) assert.ok(stored.has(s), `invented: ${s}`);
    assert.equal(await voice(A, 'three'), '', 'raised twice');
    assert.equal(await voice(A, 'four'), '', 'raised again in a later conversation');
    const st = (await (await getPool()).query('SELECT raised_count FROM aqua_revision_voice_state WHERE owner_id=$1', [A])).rows[0];
    assert.equal(st.raised_count, 1);
  });

  test('a change made in THIS conversation is not echoed back (and is decided, not deferred)', async () => {
    const A = owner('echo');
    await moved(A);
    assert.equal(await voice(A, 'two'), '');
    assert.equal(await voice(A, 'three'), '');
  });

  test('an unsettled dispute is raised as a question of which holds', async () => {
    const A = owner('dispute');
    await say(A, 'one', 'I use Redis');
    await say(A, 'one', 'I do not use Redis');
    const results = await settle(A);
    assert.ok(results.some(r => r.action === 'disputed' || r.resolved === false || /disput/.test(JSON.stringify(r))), JSON.stringify(results));
    const d = await voice(A, 'one');
    assert.match(d, /cannot both be current/);
    assert.match(d, /which one is current/);
    assert.deepEqual(new Set(quoted(d)), new Set(['I use Redis', 'I do not use Redis']));
  });

  test('a user correction is never raised back', async () => {
    const A = owner('correct');
    await say(A, 'one', 'I live in Berlin');
    const { rows: [c] } = await (await getPool()).query(
      `SELECT claim_id FROM aqua_claims WHERE owner_id=$1 AND statement_text='I live in Berlin'`, [A]);
    await repo.correctClaim({ ownerId: A, actor: 'user', claimId: c.claim_id, statementText: 'I live in Munich' });
    assert.ok((await readModel.revisionVoiceCandidates(A)).some(x => x.reason === 'user-correction'), 'the correction transition exists');
    assert.equal(await voice(A, 'two'), '');
  });

  test('a working turn neither raises nor burns the revision', async () => {
    const A = owner('suitable');
    await moved(A);
    assert.equal(await voice(A, 'three', 'coding'), '');
    assert.ok(await voice(A, 'three', 'conversation'), 'the revision was burned by an unsuitable turn');
  });

  test('concurrent turns (separate callers, one database) raise it exactly once', async () => {
    const A = owner('race');
    await moved(A);
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => voice(A, 'three')));
    assert.equal(all.filter(Boolean).length, 1, `raised ${all.filter(Boolean).length} times`);
  });

  test('flag off: silent, nothing advanced', async () => {
    const A = owner('flag');
    await moved(A);
    process.env.AQUA_REVISION_VOICE = 'off';
    try { assert.equal(await voice(A, 'three'), ''); } finally { process.env.AQUA_REVISION_VOICE = 'on'; }
    assert.ok(await voice(A, 'three'));
  });

  test('owner isolation and purge', async () => {
    const A = owner('iso');
    const B = owner('iso-other');
    await moved(A);
    assert.equal((await readModel.revisionVoiceCandidates(B)).length, 0);
    assert.equal(await voice(B, 'three'), '');
    assert.ok(await voice(A, 'three'));
    const purged = await repo.purgeOwner(A);
    assert.equal(purged.revisionVoice, 1);
    const left = await (await getPool()).query('SELECT 1 FROM aqua_revision_voice_state WHERE owner_id=$1', [A]);
    assert.equal(left.rowCount, 0);
  });
});
