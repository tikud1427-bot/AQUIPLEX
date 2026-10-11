/**
 * Natural references on a REAL Postgres (2026-10-04): people say "my company",
 * "our launch", "who owns that?" — not entity names. Generic sentences, none
 * from the World-Model Lift dataset. Scripted extraction (as in the loop test);
 * everything downstream is production. Skips visibly without a database.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.AQUA_E6 = 'on';
process.env.AQUA_CONTEXT_V2 = 'on';
process.env.AQUA_RETRIEVAL_V3 = 'on';
process.env.AQUA_SELF_ENTITY = 'on';

const { isConfigured, closePool } = await import('../../core/db/pool.js');
const LIVE = isConfigured();
const skip = LIVE ? false : 'needs a live migrated Postgres — set AQUA_TEST_DATABASE_URL';

const Brain = await import('../index.js');
const R = await import('../../core/worldModel/canonicalReadModel.js');

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OWNER = `ref-a-${run}`;
const claim = (subject, predicate, object, statementText) => ({
  subject, predicate, object, statementText, polarity: 'asserted', modality: 'fact', timePrecision: 'none', confidenceExtraction: 0.9,
});
const SCRIPT = new Map([
  ['I work at Quillbase', [claim('I', 'works_at', { entity: 'Quillbase' }, 'I work at Quillbase')]],
  ['Quillbase makes invoicing software for clinics', [claim('Quillbase', 'is_a', { literal: 'invoicing software for clinics' }, 'Quillbase makes invoicing software for clinics')]],
  ['I report to Tamsin', [claim('I', 'reports_to', { entity: 'Tamsin' }, 'I report to Tamsin')]],
  ['The Android launch deadline is May 2', [claim('Android launch', 'deadline_for', { literal: 'May 2' }, 'The Android launch deadline is May 2')]],
  ['The SSO rewrite is blocking the Android launch', [claim('SSO rewrite', 'blocks', { entity: 'Android launch' }, 'The SSO rewrite is blocking the Android launch')]],
  ['Bea owns the SSO rewrite', [claim('Bea', 'owns', { entity: 'SSO rewrite' }, 'Bea owns the SSO rewrite')]],
  ['I usually do deep work in the mornings', [claim('I', 'habit_of', { literal: 'deep work in the mornings' }, 'I usually do deep work in the mornings')]],
]);
const callModel = async (arg = {}) => {
  const seen = JSON.stringify(arg);
  const key = [...SCRIPT.keys()].sort((a, b) => b.length - a.length).find(k => seen.includes(k));
  return { text: JSON.stringify({ claims: key ? SCRIPT.get(key) : [] }), model: 'scripted/references' };
};
let turn = 0;
const say = s => Brain.understandTurn({ ownerId: OWNER, conversationId: `c-${run}`, turn: ++turn, userMessage: `${s}.`, callModel });
const empty = () => ({ items: [], block: '', stats: {} });
const ask = async (q, conversationId = null) =>
  (await Brain.assembleContextAsync(OWNER, q, empty, { limit: 8, conversationId })).block ?? '';

after(async () => { if (LIVE) await closePool(); });

test('reference resolution: live Postgres is available', { skip }, () => { assert.ok(LIVE); });

describe('natural references on live Postgres', { skip }, () => {
  test('setup: the world is built through understandTurn', async () => {
    for (const s of SCRIPT.keys()) await say(s);
  });

  test('"my company" resolves through the user\'s own works_at, not a label', async () => {
    const anchored = (await R.findEntities(OWNER, 'What does my company do?')).map(e => e.label);
    assert.ok(anchored.includes('Quillbase'), `anchored ${JSON.stringify(anchored)}`);
    assert.match(await ask('What does my company do?'), /invoicing software for clinics/);
  });

  test('"my manager" resolves through reports_to', async () => {
    const anchored = (await R.findEntities(OWNER, 'Who is my manager?')).map(e => e.label);
    assert.ok(anchored.includes('Tamsin'), `anchored ${JSON.stringify(anchored)}`);
  });

  test('"our launch" anchors on the entity whose label ends with the head noun', async () => {
    const anchored = (await R.findEntities(OWNER, 'When is our launch?')).map(e => e.label);
    assert.ok(anchored.includes('Android launch'), `anchored ${JSON.stringify(anchored)}`);
    assert.match(await ask('What is the deadline for our launch?'), /May 2/);
  });

  test('"where do I work?" puts employment first, not a claim that merely contains "work"', async () => {
    // Fact lines only: the claim under test is how FACTS rank (entity lines are
    // a separate, unranked kind).
    const lines = (await ask('Where do I work?')).split('\n').filter(l => l.startsWith('• ') && !l.startsWith('• Entity:'));
    assert.match(lines[0] ?? '', /I work at Quillbase/, `employment is not the top line:\n${lines.join('\n')}`);
  });

  test('a stray word anchors nothing: an unrelated possessive finds no entity', async () => {
    const anchored = (await R.findEntities(OWNER, 'What is my favourite colour?')).filter(e => e.type !== 'self');
    assert.deepEqual(anchored, []);
  });

  test('"who owns that?" follows the previous turn of the SAME conversation', async () => {
    const conv = `focus-${run}`;
    await ask('What is blocking the Android launch?', conv);
    const block = await ask('Who owns that?', conv);
    assert.match(block, /Bea owns the SSO rewrite/, `deictic follow-up did not resolve:\n${block}`);
  });

  test('focus never crosses conversations', async () => {
    const block = await ask('Who owns that?', `other-${run}`);
    // The invariant is about what "that" RESOLVES to — the relevance section.
    // The current-world section (worldCore, 2026-10-11) shows the owner's
    // current facts in every conversation by design; that is not focus.
    const relevance = block.split('── ALSO CURRENTLY TRUE')[0];
    assert.doesNotMatch(relevance, /SSO rewrite is blocking/, 'a different conversation inherited the focus');
  });
});
