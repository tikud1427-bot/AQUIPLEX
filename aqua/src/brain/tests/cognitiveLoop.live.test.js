/**
 * THE COGNITIVE LOOP, END TO END, ON A REAL POSTGRES (Blueprint V2 §2.8, L12).
 *
 *   user turn → understandTurn (S0–S9) → canonical claims in Postgres
 *   → Context Engine over the canonical World Model → the text the model reads
 *   → a later turn changes the world → contradiction event → worker policy
 *   → user correction → supersession + provenance → the next context changes
 *
 * Every function exercised is the production one. The ONLY stand-in is the
 * extraction model: `callModel` returns scripted JSON per sentence, because a
 * test cannot call Groq. So this proves WIRING, not extraction quality — E6's
 * quality gate is scripts/e6-shadow.mjs and nothing here substitutes for it.
 *
 * Each assertion below corresponds to a defect found on live Postgres on
 * 2026-10-03 that no fixture-backed test could see:
 *   · first-person claims blocked `no-self-entity` (self node never created on
 *     the understanding path)
 *   · every entity committed as type 'concept' (store `kind` vs repo `type`)
 *   · `findEntities` matched the whole question inside a label — natural
 *     questions anchored on nothing
 *   · canonical facts reached the prompt as "• undefined" (`text` vs `statement`)
 *   · claimWithEvidence / listEntities / getEntity selected columns the schema
 *     does not have — every claim.reflection.v1 job failed
 *   · contradiction events carried `incomingClaimId: null` — every
 *     claim.contradiction.v1 job threw
 *
 * Needs a live, migrated database:
 *   AQUA_TEST_DATABASE_URL=postgresql://…/aqua_test npm run db:migrate   (with DATABASE_URL set to it)
 *   AQUA_TEST_DATABASE_URL=postgresql://…/aqua_test node scripts/run-tests.mjs src/brain/tests/cognitiveLoop.live.test.js
 * Without one every test SKIPS and says so — a skip is visible, a fake pass is not.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.AQUA_E6 = 'on';
process.env.AQUA_CONTEXT_V2 = 'on';
process.env.AQUA_RETRIEVAL_V3 = 'on';
process.env.AQUA_SELF_ENTITY = 'on';

const { isConfigured, getPool, closePool } = await import('../../core/db/pool.js');
const LIVE = isConfigured();
const skip = LIVE ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL (see header)';

const Brain = await import('../index.js');
const R = await import('../../core/worldModel/canonicalReadModel.js');
const W = await import('../../core/worldModel/worldModelRepository.js');
const { runClaimContradictionJob } = await import('../reflectionV3/contradictionWorker.js');

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OWNER = `loop-a-${run}`;
const OTHER = `loop-b-${run}`;
const empty = () => ({ items: [], block: '', stats: {} });

const claim = (subject, predicate, object, statementText, extra = {}) => ({
  subject, predicate, object, statementText,
  polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9, ...extra,
});

/** The scripted extractor: sentence → what a correct extractor would emit. */
const SCRIPT = new Map([
  ['I am building AQUIPLEX', [claim('I', 'builds', { literal: 'AQUIPLEX' }, 'I am building AQUIPLEX')]],
  ['I want to launch AQUIPLEX in November', [claim('I', 'plans_to', { literal: 'launch AQUIPLEX in November' }, 'I want to launch AQUIPLEX in November', { modality: 'intent' })]],
  ['Reliability is blocking the launch', [claim('reliability', 'blocks', { entity: 'launch' }, 'Reliability is blocking the launch')]],
  ['Priya owns the onboarding flow', [claim('Priya', 'owns', { entity: 'onboarding flow' }, 'Priya owns the onboarding flow')]],
  ['The launch deadline is November 15', [claim('launch', 'deadline_for', { literal: 'November 15' }, 'The launch deadline is November 15')]],
  ['The reliability blocker is resolved but the auth issue is blocking the launch', [
    claim('reliability', 'blocks', { entity: 'launch' }, 'The reliability blocker is resolved', { polarity: 'negated' }),
    claim('auth issue', 'blocks', { entity: 'launch' }, 'the auth issue is blocking the launch'),
  ]],
]);
const callModel = async (arg = {}) => {
  const seen = JSON.stringify(arg);
  const key = [...SCRIPT.keys()].find(k => seen.includes(k));
  return { text: JSON.stringify({ claims: key ? SCRIPT.get(key) : [] }), model: 'scripted/cognitive-loop' };
};

let turn = 0;
const say = (ownerId, sentence, t = ++turn) =>
  Brain.understandTurn({ ownerId, conversationId: `conv-${run}`, turn: t, userMessage: `${sentence}.`, callModel });
const ask = async (ownerId, q) => (await Brain.assembleContextAsync(ownerId, q, empty, { limit: 8 })).block ?? '';
/** What the chat path actually passes: the classifier labels these `simple_qa`. */
const askAsChat = async (ownerId, q) => {
  const ctx = await Brain.assembleContextAsync(ownerId, q, empty, { limit: 8, taskType: 'simple_qa' });
  return { block: ctx.block ?? '', ce: ctx.stats?.contextEngine ?? {}, items: ctx.items ?? [] };
};
// Slot membership is item metadata; the rendered line no longer shows it (2026-10-05).
const inSlot = (items, text, slot) => items.some(it =>
  String(it.text ?? it.statement ?? '').includes(text) && [...(it.slotIds ?? []), ...(it.provenance?.slotIds ?? [])].includes(slot));
const claimsOf = async (ownerId, predicate) => (await (await getPool()).query(
  `SELECT claim_id, statement_text, state, polarity, superseded_by FROM aqua_claims
    WHERE owner_id=$1 AND predicate=$2 ORDER BY asserted_at, claim_id`, [ownerId, predicate])).rows;

after(async () => { if (LIVE) await closePool(); });

// Counted as SKIPPED when there is no database, so the gap shows in the totals.
test('cognitive loop: live Postgres is available for this run', { skip }, () => { assert.ok(LIVE); });

describe('cognitive loop on live Postgres', { skip }, () => {
  test('1 · turns become canonical claims — first person included, self typed as self', async () => {
    for (const s of ['I am building AQUIPLEX', 'I want to launch AQUIPLEX in November',
      'Reliability is blocking the launch', 'Priya owns the onboarding flow']) {
      const r = await say(OWNER, s);
      assert.ok(r?.readyForS7?.length >= 1, `"${s}" never became S7-ready: ${JSON.stringify(r?.claims?.map(c => c.resolution))}`);
    }
    const builds = await claimsOf(OWNER, 'builds');
    assert.deepEqual(builds.map(c => [c.statement_text, c.state]), [['I am building AQUIPLEX', 'active']],
      'a first-person claim did not reach the world model');
    const selfRows = (await (await getPool()).query(
      `SELECT type FROM aqua_entities WHERE owner_id=$1 AND canonical_label='You'`, [OWNER])).rows;
    assert.deepEqual(selfRows.map(r => r.type), ['self'], 'the user is not stored as the owner\'s self entity');
  });

  test('2 · replaying the same turn writes nothing new (idempotent on source + span + extractor)', async () => {
    const before = (await claimsOf(OWNER, 'builds')).length;
    await say(OWNER, 'I am building AQUIPLEX', 1);
    assert.equal((await claimsOf(OWNER, 'builds')).length, before, 'a replayed turn duplicated its claims');
  });

  test('3 · the model is handed the claims themselves, never "undefined"', async () => {
    const block = await ask(OWNER, 'What is blocking the launch?');
    assert.match(block, /Reliability is blocking the launch/, `canonical claim missing from context:\n${block}`);
    assert.doesNotMatch(block, /• undefined/, 'a canonical fact reached the prompt without its text');
    assert.doesNotMatch(block, /\[object Object\]/,'a raw evidence row reached the prompt as [object Object]');
    assert.match(await ask(OWNER, 'Who owns onboarding?'), /Priya owns the onboarding flow/,
      'entity anchoring from a natural question failed');
    // Anchoring itself, isolated from predicate hints (which can mask it):
    // a natural question must anchor on the entity it names.
    const anchored = (await R.findEntities(OWNER, 'What is blocking the launch?')).map(e => e.label);
    assert.ok(anchored.includes('launch'), `a natural question anchored on ${JSON.stringify(anchored)}, not "launch"`);
    const noSelf = (await R.findEntities(OWNER, 'Can you summarise the launch?')).map(e => e.type);
    assert.ok(!noSelf.includes('self'), '"you" (addressing Aqua) anchored on the user');
  });

  test('4 · first-person questions anchor on the user (self lane)', async () => {
    const block = await ask(OWNER, 'What am I building?');
    assert.match(block, /I am building AQUIPLEX/, `self-anchored claim missing:\n${block}`);
  });

  test('4b · a question that names none of it gets the slice of the world model it depends on', async () => {
    // "What should I focus on next?" mentions no goal, blocker or deadline. The
    // decision scaffold fetches them by the predicates that define them.
    for (const q of ['What should I focus on next?', 'Should I launch this week?']) {
      const { block, ce, items } = await askAsChat(OWNER, q);
      assert.match(block, /Reliability is blocking the launch/, `${q}: the blocker is missing:\n${block}`);
      assert.ok(inSlot(items, 'Reliability is blocking the launch', 'blockers'), `${q}: the blocker does not fill the blockers slot`);
      assert.match(block, /I want to launch AQUIPLEX in November/, `${q}: the goal is missing:\n${block}`);
      assert.ok(inSlot(items, 'I want to launch AQUIPLEX in November', 'goal'), `${q}: the goal does not fill the goal slot`);
      // Nothing about a deadline has been said: named as unknown, never guessed.
      assert.deepEqual(ce.requiredSlotsMissing, ['deadline'], q);
      assert.match(block, /EVIDENCE STATUS: PARTIAL/);
      assert.match(block, /Not known: deadline/);
    }
  });

  test('4c · saying the missing thing later fills the slot — the next answer is SUFFICIENT', async () => {
    await say(OWNER, 'The launch deadline is November 15');
    const { block, ce, items } = await askAsChat(OWNER, 'Should I launch this week?');
    assert.deepEqual(ce.requiredSlotsMissing, []);
    assert.match(block, /The launch deadline is November 15/);
    assert.ok(inSlot(items, 'The launch deadline is November 15', 'deadline'), 'the deadline does not fill its slot');
    assert.match(block, /EVIDENCE STATUS: SUFFICIENT/);
  });

  test('5 · owner isolation is structural: another owner sees, finds and corrects nothing', async () => {
    assert.doesNotMatch(await ask(OTHER, 'What is blocking the launch?'), /Reliability|AQUIPLEX|Priya/,
      'owner B was shown owner A\'s world model');
    assert.deepEqual(await R.findEntities(OTHER, 'launch'), []);
    const [target] = await claimsOf(OWNER, 'owns');
    await assert.rejects(
      W.correctClaim({ ownerId: OTHER, actor: `user:${OTHER}`, claimId: target.claim_id, statementText: 'hijack' }),
      /not found/, 'owner B could correct owner A\'s claim');
    assert.equal((await claimsOf(OWNER, 'owns'))[0].state, 'active', 'owner A\'s claim changed under owner B');
  });

  test('6 · a later turn changes the world: contradiction reaches the worker WITH both ids, policy runs', async () => {
    await say(OWNER, 'The reliability blocker is resolved but the auth issue is blocking the launch');
    const { rows: events } = await (await getPool()).query(
      `SELECT payload FROM aqua_outbox WHERE owner_id=$1 AND event_type='claim.contradiction.detected'`, [OWNER]);
    assert.equal(events.length, 1, 'the polarity flip produced no contradiction event');
    const { incomingClaimId, existingClaimId } = events[0].payload;
    assert.ok(incomingClaimId && existingClaimId, `contradiction event is not actionable: ${JSON.stringify(events[0].payload)}`);

    await runClaimContradictionJob({ ownerId: OWNER, payload: events[0].payload });

    const blocks = await claimsOf(OWNER, 'blocks');
    const old = blocks.find(c => c.statement_text === 'Reliability is blocking the launch');
    assert.notEqual(old.state, 'active', 'the contradicted claim is still presented as settled current truth');
    assert.equal(blocks.find(c => c.statement_text.startsWith('the auth issue')).state, 'active');
    const block = await ask(OWNER, 'What is blocking the launch?');
    assert.match(block, /auth issue is blocking the launch/, `the new state did not reach the context:\n${block}`);
  });

  test('7 · correction: supersession, provenance, and the next context uses the corrected state', async () => {
    const [target] = await claimsOf(OWNER, 'owns');
    const out = await W.correctClaim({
      ownerId: OWNER, actor: `user:${OWNER}`, claimId: target.claim_id,
      statementText: 'Maya owns the onboarding flow, not Priya',
    });
    const owns = await claimsOf(OWNER, 'owns');
    const oldRow = owns.find(c => c.claim_id === target.claim_id);
    assert.equal(oldRow.state, 'superseded');
    assert.equal(oldRow.superseded_by, out.claimId, 'the old claim does not point at its successor');

    const detail = await W.claimWithEvidence(OWNER, out.claimId);
    assert.ok(detail?.evidence?.length >= 1, 'the corrected claim has no evidence — provenance lost');
    const { rows: corr } = await (await getPool()).query(
      `SELECT action FROM aqua_corrections WHERE owner_id=$1 AND target_id=$2`, [OWNER, target.claim_id]);
    assert.deepEqual(corr.map(r => r.action), ['correct'], 'the correction left no audit row');

    const block = await ask(OWNER, 'Who owns onboarding?');
    assert.match(block, /Maya owns the onboarding flow/, `corrected state missing:\n${block}`);
    assert.doesNotMatch(block, /• Priya owns the onboarding flow/, 'the superseded claim is still presented as current');
  });

  test('8 · every canonical read the product surfaces call runs against the real schema', async () => {
    const pool = await getPool();
    const ent = (await pool.query('SELECT entity_id FROM aqua_entities WHERE owner_id=$1 LIMIT 1', [OWNER])).rows[0].entity_id;
    const cl = (await pool.query('SELECT claim_id FROM aqua_claims WHERE owner_id=$1 LIMIT 1', [OWNER])).rows[0].claim_id;
    const reads = {
      listEntities: () => R.listEntities(OWNER), getEntity: () => R.getEntity(OWNER, ent),
      getRelationships: () => R.getRelationships(OWNER, ent), getObservations: () => R.getObservations(OWNER, ent),
      getEvents: () => R.getEvents(OWNER), getTimeline: () => R.getTimeline(OWNER), worldStats: () => R.worldStats(OWNER),
      readClaims: () => R.readClaims(OWNER, [cl]), listClaims: () => R.listClaims(OWNER),
      searchClaims: () => R.searchClaims(OWNER, 'launch'), structuredClaims: () => R.structuredClaims(OWNER, { predicates: ['blocks'] }),
      claimWithEvidence: () => W.claimWithEvidence(OWNER, cl),
    };
    const failed = [];
    for (const [name, fn] of Object.entries(reads)) {
      try { await fn(); } catch (err) { failed.push(`${name}: ${err.message}`); }
    }
    assert.deepEqual(failed, [], `reads that fail on the live schema:\n${failed.join('\n')}`);
  });

  test('9 · re-explanation (§2.10): restating a known fact in a NEW turn is counted, for this owner only', async () => {
    const before = await R.reexplanationStats(OWNER);
    await say(OWNER, 'I am building AQUIPLEX');            // a new turn → a new source → S8 corroboration
    const after = await R.reexplanationStats(OWNER);
    assert.equal(after.reexplained, before.reexplained + 1, `restatement not counted: ${JSON.stringify(after)}`);
    assert.equal(after.statements, before.statements + 1);
    assert.ok(after.rate > 0 && after.rate < 1);
    assert.equal(after.lowerBound, true);
    assert.equal((await R.reexplanationStats(OTHER)).reexplained, 0, 'another owner\'s restatements leaked into this one');
  });
});
