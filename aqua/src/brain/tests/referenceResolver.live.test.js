/**
 * S6½ on a REAL Postgres: references the minter would refuse are resolved from
 * the owner's existing World Model only when unambiguous, with provenance in
 * the evidence row; ambiguous/unresolved/location references commit nothing.
 * Scripted extraction (surfaces as a model would emit them); everything else
 * production. Skips visibly without AQUA_TEST_DATABASE_URL.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.AQUA_E6 = 'on';
process.env.AQUA_SELF_ENTITY = 'on';

const { isConfigured, getPool, closePool } = await import('../../core/db/pool.js');
const LIVE = isConfigured();
const skip = LIVE ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';
const Brain = await import('../index.js');

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const OWNER = `refw-a-${run}`;
const OTHER = `refw-b-${run}`;
const claim = (subject, predicate, object, statementText) => ({
  subject, predicate, object, statementText, polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9,
});
const SCRIPT = new Map([
  ['I work at Quillbase', [claim('I', 'works_at', { entity: 'Quillbase' }, 'I work at Quillbase')]],
  ['My company raised a seed round', [claim('My company', 'has_status', { literal: 'raised a seed round' }, 'My company raised a seed round')]],
  ['I am on the Platform team', [claim('I', 'member_of', { entity: 'Platform team' }, 'I am on the Platform team')]],
  ['I am on the Growth team', [claim('I', 'member_of', { entity: 'Growth team' }, 'I am on the Growth team')]],
  ['Our team shipped the release', [claim('Our team', 'has_status', { literal: 'shipped the release' }, 'Our team shipped the release')]],
  ['My manager is great', [claim('My manager', 'has_property', { literal: 'great' }, 'My manager is great')]],
  ['Our office moved to Bangalore', [claim('Our office', 'located_in', { entity: 'Bangalore' }, 'Our office moved to Bangalore')]],
  ['The billing service is slow', [claim('The billing service', 'has_property', { literal: 'slow' }, 'The billing service is slow')]],
  ['It is owned by Omar', [claim('It', 'owned_by', { entity: 'Omar' }, 'It is owned by Omar')]],
  ['I lead the Android launch', [claim('I', 'owns', { entity: 'Android launch' }, 'I lead the Android launch')]],
  ['The launch slipped', [claim('The launch', 'has_status', { literal: 'slipped' }, 'The launch slipped')]],
]);
const callModel = async (arg = {}) => {
  const seen = JSON.stringify(arg);
  const key = [...SCRIPT.keys()].sort((a, b) => b.length - a.length).find(k => seen.includes(k));
  return { text: JSON.stringify({ claims: key ? SCRIPT.get(key) : [] }), model: 'scripted/references-write' };
};
let turn = 0;
const say = (ownerId, s, conv = `c-${run}`) => Brain.understandTurn({ ownerId, conversationId: conv, turn: ++turn, userMessage: `${s}.`, callModel });
const claimRow = async (ownerId, text) => (await (await getPool()).query(
  `SELECT c.claim_id, c.state, s.canonical_label AS subject, ev.locator
     FROM aqua_claims c
     JOIN aqua_entities s ON s.owner_id=c.owner_id AND s.entity_id=c.subject_entity_id
     JOIN aqua_claim_evidence ce ON ce.owner_id=c.owner_id AND ce.claim_id=c.claim_id
     JOIN aqua_evidence ev ON ev.owner_id=ce.owner_id AND ev.evidence_id=ce.evidence_id
    WHERE c.owner_id=$1 AND c.statement_text=$2`, [ownerId, text])).rows[0] ?? null;

after(async () => { if (LIVE) await closePool(); });
test('references (write side): live Postgres is available', { skip }, () => { assert.ok(LIVE); });

describe('S6½ on live Postgres', { skip }, () => {
  test('"my company" resolves through self works_at — committed under Quillbase, with provenance', async () => {
    await say(OWNER, 'I work at Quillbase');
    const r = await say(OWNER, 'My company raised a seed round');
    assert.equal(r.stats.s6.references.resolved, 1, JSON.stringify(r.stats.s6));
    const row = await claimRow(OWNER, 'My company raised a seed round');
    assert.ok(row, 'the claim was not committed');
    assert.equal(row.subject, 'Quillbase');
    assert.deepEqual(row.locator.references?.[0]?.method, 'role');
    assert.equal(row.locator.references[0].via, 'self works_at');
  });

  test('two teams: "our team" is AMBIGUOUS — nothing committed, uncertainty recorded', async () => {
    await say(OWNER, 'I am on the Platform team');
    await say(OWNER, 'I am on the Growth team');
    const r = await say(OWNER, 'Our team shipped the release');
    assert.equal(r.stats.s6.references.ambiguous, 1);
    assert.equal(await claimRow(OWNER, 'Our team shipped the release'), null);
  });

  test('no manager known: "my manager" stays unresolved — nothing committed', async () => {
    const r = await say(OWNER, 'My manager is great');
    assert.equal(r.stats.s6.references.unresolved, 1);
    assert.equal(await claimRow(OWNER, 'My manager is great'), null);
  });

  test('"our office" is never resolved to the user\'s city (it would be a false fact)', async () => {
    await say(OWNER, 'Our office moved to Bangalore');
    assert.equal(await claimRow(OWNER, 'Our office moved to Bangalore'), null);
  });

  test('"it" resolves to the one entity of the previous turn (cross-turn)', async () => {
    const conv = `pron-${run}`;
    await say(OWNER, 'The billing service is slow', conv);
    const r = await say(OWNER, 'It is owned by Omar', conv);
    assert.equal(r.stats.s6.references.resolved, 1, JSON.stringify(r.stats.s6));
    const row = await claimRow(OWNER, 'It is owned by Omar');
    assert.equal(row?.subject, 'billing service');
    assert.equal(row.locator.references[0].method, 'pronoun');
  });

  test('"the launch" resolves by head noun to the one launch entity', async () => {
    await say(OWNER, 'I lead the Android launch');
    const r = await say(OWNER, 'The launch slipped');
    assert.equal(r.stats.s6.references.resolved, 1, JSON.stringify(r.stats.s6));
    assert.equal((await claimRow(OWNER, 'The launch slipped'))?.subject, 'Android launch');
  });

  test('owner isolation: another owner\'s entities are never candidates', async () => {
    const r = await say(OTHER, 'My company raised a seed round');
    assert.equal(r.stats.s6.references.resolved, 0);
    assert.equal(await claimRow(OTHER, 'My company raised a seed round'), null);
  });
});
