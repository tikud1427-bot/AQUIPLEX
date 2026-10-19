/**
 * Processing a turn more than once never changes the state after the first
 * successful application (2026-10-18) — live Postgres.
 *
 * The understanding job is retried after a crash, a provider error, or a
 * failure in ANOTHER segment of the same turn; a retried process has a cold
 * extraction cache, so the model reads the sentence again — possibly
 * differently. Measured before this fix: a segment whose first reading
 * committed nothing wrote no ledger row, and its second reading committed
 * claims the first application never had.
 *
 * Scripted extractor per segment text; each test uses its own owner.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-idempotency-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
Object.assign(process.env, { AQUA_BRAIN: 'on', AQUA_UUS: 'on', AQUA_SELF_ENTITY: 'on', AQUA_E6: 'on', AQUA_E6_COMMIT: 'on' });

const { isConfigured, getPool } = await import('../../core/db/pool.js');
const skip = isConfigured() ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';
const Brain = await import('../index.js');
const { __clearExtractionCache } = await import('../understanding/extractionClient.js');
const { purgeOwnerData } = await import('../../account/accountPurge.js');
const W = await import('../../core/worldModel/worldModelRepository.js');

const RUN = `idem-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const users = [];
let k = 0;
const newOwner = () => { const u = `${RUN}-${k++}`; users.push(u); return `user:${u}`; };
const claim = (subject, predicate, object, statementText, over = {}) => ({
  subject, predicate, object, polarity: 'asserted', modality: 'fact', timePrecision: 'none', statementText, ...over });
const S1 = 'We switched hosting to Render.';
const S2 = 'The Pro plan is now $79 per month.';
const MSG = `${S1} ${S2}`;
// readings: { [sentence]: claims[] | 'error' }
const model = readings => async ({ user }) => {
  const seg = [S1, S2].find(s => user.includes(s));
  const r = readings[seg];
  if (r === 'error') throw new Error('provider unavailable');
  return { text: JSON.stringify({ claims: r ?? [] }), model: 'scripted' };
};
const A1 = [claim('self', 'uses', { entity: 'Render' }, 'We switched hosting to Render', { revises: true })];
const A2 = [claim('Pro plan', 'has_property', { literal: '$79 per month' }, 'The Pro plan is now $79 per month', { revises: true })];
const B1 = [claim('self', 'uses', { entity: 'Fly.io' }, 'We switched hosting to Render')];   // a different (wrong) re-reading
const B2 = [claim('Pro plan', 'has_property', { literal: '$80 per month' }, 'The Pro plan is now $79 per month')];
async function run(owner, readings, { conversationId = 'c', turn = 1, message = MSG } = {}) {
  __clearExtractionCache();   // a retried process has a cold cache
  return Brain.understandTurn({ ownerId: owner, conversationId, turn, userMessage: message, callModel: model(readings), assertedAt: '2026-01-05T09:00:00.000Z' });
}
async function state(owner) {
  const p = await getPool();
  const { rows } = await p.query(`SELECT c.predicate, c.state, coalesce(oe.canonical_label, c.object_literal) AS o
      FROM aqua_claims c LEFT JOIN aqua_entities oe ON oe.owner_id=c.owner_id AND oe.entity_id=c.object_entity_id
     WHERE c.owner_id=$1 ORDER BY 1, 3, 2`, [owner]);
  const ledger = (await p.query('SELECT count(*)::int n FROM aqua_understanding_commit_ledger WHERE owner_id=$1', [owner])).rows[0].n;
  const evidence = (await p.query('SELECT count(*)::int n FROM aqua_evidence WHERE owner_id=$1', [owner])).rows[0].n;
  return { claims: rows.map(r => `${r.predicate}:${r.o}:${r.state}`), ledger, evidence };
}

describe('understanding is idempotent across retries', { skip }, () => {
  after(async () => { for (const u of users) await purgeOwnerData({ userId: u }); });

  test('the same source processed three times, with different readings, keeps the first application', async () => {
    const o = newOwner();
    await run(o, { [S1]: A1, [S2]: A2 });
    const first = await state(o);
    await run(o, { [S1]: B1, [S2]: B2 });
    await run(o, { [S1]: A1, [S2]: A2 });
    assert.deepEqual(await state(o), first);
    assert.equal(first.ledger, 2);
  });

  test('retry after partial persistence: the failed segment is applied, the completed one is not re-read', async () => {
    const o = newOwner();
    const r1 = await run(o, { [S1]: A1, [S2]: 'error' });
    assert.equal(r1.stats.errors, 1);
    const partial = await state(o);
    assert.equal(partial.ledger, 1, 'only the completed segment is ledgered');
    await run(o, { [S1]: B1, [S2]: A2 });      // the retry: segment 1 re-read differently, segment 2 now works
    const after = await state(o);
    assert.equal(after.ledger, 2);
    assert.ok(after.claims.some(c => c.startsWith('uses:Render')), JSON.stringify(after));
    assert.ok(!after.claims.some(c => c.includes('Fly.io')), 'the completed segment was not re-applied');
    assert.ok(after.claims.some(c => c.includes('$79 per month')));
  });

  test('an empty but successful first reading is final', async () => {
    const o = newOwner();
    await run(o, { [S1]: [], [S2]: [] });
    const first = await state(o);
    await run(o, { [S1]: A1, [S2]: A2 });
    assert.deepEqual(await state(o), first);
    assert.equal(first.ledger, 2);
  });

  test('a reading whose every claim fails validation is a failed reading: not ledgered, the retry applies', async () => {
    const o = newOwner();
    const invalid = [claim('self', 'uses', { entity: 'Render' }, 'We switched hosting to Heroku and Fly')];   // quote not in the sentence → discarded
    await run(o, { [S1]: invalid }, { message: S1 });
    const first = await state(o);
    assert.deepEqual(first, { claims: [], ledger: 0, evidence: 0 });
    await run(o, { [S1]: A1 }, { message: S1 });
    const s = await state(o);
    assert.equal(s.claims.filter(c => c.startsWith('uses:Render')).length, 1);
    assert.equal(s.ledger, 1);
  });

  test('concurrent retries of one turn apply exactly one reading', async () => {
    const o = newOwner();
    // Two VALID, different readings. (Both attempts run in this one process and
    // share the in-memory extraction cache, which separate workers do not; an
    // invalid reading winning that cache is a test artefact, and the invalid-
    // reading case has its own test above.)
    const B2valid = [claim('Pro plan', 'has_property', { literal: 'now $79 per month' }, 'The Pro plan is now $79 per month')];
    await Promise.all([run(o, { [S1]: A1, [S2]: A2 }), run(o, { [S1]: B1, [S2]: B2valid })]);
    const s = await state(o);
    assert.equal(s.ledger, 2);
    const usesRender = s.claims.filter(c => c.startsWith('uses:Render')).length, usesFly = s.claims.filter(c => c.startsWith('uses:Fly.io')).length;
    assert.equal(usesRender + usesFly, 1, JSON.stringify(s));
    assert.equal(s.claims.filter(c => c.startsWith('has_property:')).length, 1, JSON.stringify(s));
  });

  test('a crash after some writes rolls the segment back entirely — claims, evidence AND ledger; the retry applies it once', async () => {
    const o = newOwner();
    const sourceId = (await import('node:crypto')).randomUUID();
    const base = { ownerId: o, sourceId, actor: 'e6:test', extractorVersion: 'e6-v1', segmentRange: { start: 0, end: 30 }, sourceKind: 'conversation', externalRef: 'c:turn:1' };
    const ready = (over) => ({ subject: 'You', predicate: 'uses', objectKind: 'literal', object: { literal: 'Render' }, statementText: 'We switched hosting to Render',
      polarity: 'asserted', modality: 'fact', timePrecision: 'none', resolution: { ready: true }, _canonicalSubject: { name: 'You', canonical: 'You', type: 'self' }, ...over });
    // Second claim: valid_to before valid_from → aqua_claims_validity_ck fails AFTER the first claim's rows were written.
    await assert.rejects(W.commitUnderstanding({ ...base, claims: [ready({}), ready({ object: { literal: 'Heroku' }, validFrom: '2026-06-01T00:00:00Z', validTo: '2025-01-01T00:00:00Z' })] }));
    const crashed = await state(o);
    assert.deepEqual(crashed, { claims: [], ledger: 0, evidence: 0 }, 'a half-written segment survived the crash');
    const ok = await W.commitUnderstanding({ ...base, claims: [ready({})] });
    const again = await W.commitUnderstanding({ ...base, claims: [ready({ object: { literal: 'Fly.io' } })] });
    assert.equal(ok.skipped ?? false, false);
    assert.equal(again.skipped, true);
    const s = await state(o);
    assert.deepEqual(s.claims.map(c => c.split(':').slice(0, 2).join(':')), ['uses:Render']);
    assert.equal(s.ledger, 1);
  });

  test('a deletion between attempts is not undone by the retry', async () => {
    const o = newOwner();
    await run(o, { [S1]: A1, [S2]: 'error' });
    const p = await getPool();
    const { rows: [c] } = await p.query(`SELECT claim_id FROM aqua_claims WHERE owner_id=$1 AND predicate='uses'`, [o]);
    await W.transition({ ownerId: o, targetKind: 'claim', targetId: c.claim_id, toState: 'archived', actor: 'user', reason: 'user deleted' });
    await run(o, { [S1]: A1, [S2]: A2 });
    const s = await state(o);
    assert.ok(s.claims.includes('uses:Render:archived'), JSON.stringify(s));
    assert.ok(!s.claims.some(x => x.startsWith('uses:Render:') && !x.endsWith(':archived')), 'the deleted claim came back');
  });

  test('a correction between attempts is not undone by the retry', async () => {
    const o = newOwner();
    await run(o, { [S1]: A1, [S2]: 'error' });
    const p = await getPool();
    const { rows: [c] } = await p.query(`SELECT claim_id FROM aqua_claims WHERE owner_id=$1 AND predicate='uses'`, [o]);
    await Brain.correctWorldModelClaimValue(o, c.claim_id, 'Vercel');
    await run(o, { [S1]: A1, [S2]: A2 });
    const s = await state(o);
    const current = s.claims.filter(x => x.startsWith('uses:') && !/:(superseded|archived)$/.test(x));
    assert.deepEqual(current.map(x => x.split(':')[1]), ['Vercel'], JSON.stringify(s));
    assert.ok(s.claims.some(x => x.includes('$79 per month')), 'the failed segment was still applied');
  });

  test('the same words in two turns that MEAN different things are both applied (keyed by source, not by text)', async () => {
    const o = newOwner();
    // Turn 1: the demo moved. Turn 2, a week later, the same words about the
    // launch. (Gate 5 needs the subject in the sentence, so both are named.)
    const T = 'The demo and the launch moved to Friday.';
    const launch = [claim('launch', 'deadline_for', { literal: 'Friday' }, 'The demo and the launch moved to Friday')];
    const demo = [claim('demo', 'deadline_for', { literal: 'Friday' }, 'The demo and the launch moved to Friday')];
    const say = r => async () => ({ text: JSON.stringify({ claims: r }), model: 'scripted' });
    __clearExtractionCache();
    await Brain.understandTurn({ ownerId: o, conversationId: 'c', turn: 1, userMessage: T, callModel: say(launch), assertedAt: '2026-01-05T09:00:00.000Z' });
    __clearExtractionCache();
    await Brain.understandTurn({ ownerId: o, conversationId: 'c', turn: 2, userMessage: T, callModel: say(demo), assertedAt: '2026-01-06T09:00:00.000Z' });
    const p = await getPool();
    const { rows } = await p.query(`SELECT lower(se.canonical_label) s FROM aqua_claims c JOIN aqua_entities se ON se.owner_id=c.owner_id AND se.entity_id=c.subject_entity_id
       WHERE c.owner_id=$1 AND c.predicate='deadline_for' ORDER BY 1`, [o]);
    assert.deepEqual(rows.map(r => r.s), ['demo', 'launch']);
    assert.equal((await state(o)).ledger, 2);
  });

  test('the same sentence in a NEW turn is a restatement (evidence), not a skipped duplicate or a second claim', async () => {
    const o = newOwner();
    await run(o, { [S1]: A1 }, { message: S1, turn: 1 });
    await run(o, { [S1]: A1 }, { message: S1, turn: 2 });
    const s = await state(o);
    assert.equal(s.claims.filter(c => c.startsWith('uses:Render')).length, 1);
    assert.equal(s.ledger, 2, 'two sources, each applied once');
    assert.ok(s.evidence >= 2, 'the second turn is recorded as evidence');
  });
});
