/**
 * The actor retry (2026-10-18): one extra, code-triggered attempt when a NAMED
 * person who acts in the sentence appears in no claim. Reproduced live: "Kofi
 * is helping me build Atlas on weekends" → (self, builds, Atlas) only; the
 * person doing the work was lost.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runUnderstandingPipeline, uncoveredActors, mergeActorRetry } from '../understanding/pipeline.js';
import { __clearExtractionCache } from '../understanding/extractionClient.js';

const base = { polarity: 'asserted', modality: 'fact', timePrecision: 'none' };
const SELF = { ...base, subject: 'self', predicate: 'builds', object: { entity: 'Atlas' }, statementText: 'Kofi is helping me build Atlas on weekends' };
const KOFI = { ...base, subject: 'Kofi', predicate: 'builds', object: { entity: 'Atlas' }, statementText: 'Kofi is helping me build Atlas on weekends' };
const WRONG = { ...base, subject: 'self', predicate: 'owns', object: { entity: 'Atlas' }, statementText: 'Kofi is helping me build Atlas on weekends' };
function model({ first = [SELF], hinted = [SELF, KOFI] } = {}) {
  const calls = [];
  const fn = async ({ user }) => {
    calls.push(user);
    return { text: JSON.stringify({ claims: /NOTE: the sentence says what/.test(user) ? hinted : first }), model: 'scripted' };
  };
  fn.calls = calls;
  return fn;
}
const run = (text, callModel) => runUnderstandingPipeline(text, { callModel, assertedAt: '2026-10-18T00:00:00Z' });

describe('actor retry', () => {
  afterEach(() => { delete process.env.AQUA_E6_ACTOR_RETRY; __clearExtractionCache(); });

  test('a dropped actor is asked for once, by name; their claim is kept beside the speaker\'s', async () => {
    __clearExtractionCache();
    const m = model();
    const r = await run('Kofi is helping me build Atlas on weekends.', m);
    assert.equal(m.calls.length, 2);
    assert.match(m.calls[1], /what "Kofi" does/);
    assert.equal(r.stats.actorRetries, 1);
    assert.deepEqual(r.claims.map(c => String(c.subject).toLowerCase()).sort(), ['kofi', 'self']);
  });

  test('only claims that mention the missing actor are taken from the second reading', async () => {
    __clearExtractionCache();
    const r = await run('Kofi is helping me build Atlas on weekends.', model({ hinted: [WRONG, KOFI] }));
    assert.ok(!r.claims.some(c => c.predicate === 'owns'), 'a re-reading about the speaker must not be added');
    assert.ok(r.claims.some(c => String(c.subject).toLowerCase() === 'kofi'));
  });

  test('no retry when the actor is covered, for the speaker or a pronoun, or for a question', async () => {
    for (const [text, first] of [
      ['Kofi is helping me build Atlas on weekends.', [SELF, KOFI]],
      ['I build Atlas on weekends.', [SELF]],
      ['She leads design now.', [{ ...base, subject: 'She', predicate: 'role_is', object: { literal: 'leads design' }, statementText: 'She leads design now' }]],
      ['Is Kofi helping me build Atlas?', [SELF]],
    ]) {
      __clearExtractionCache();
      const m = model({ first });
      await run(text, m);
      assert.equal(m.calls.length, 1, text);
    }
  });

  test('AQUA_E6_ACTOR_RETRY=off turns it off', async () => {
    process.env.AQUA_E6_ACTOR_RETRY = 'off';
    __clearExtractionCache();
    const m = model();
    await run('Kofi is helping me build Atlas on weekends.', m);
    assert.equal(m.calls.length, 1);
  });

  test('detection: active and passive actors; names already covered are not asked for', () => {
    assert.deepEqual(uncoveredActors('Kofi is helping me build Atlas.', [SELF]), ['Kofi']);
    assert.deepEqual(uncoveredActors('The Atlas app was built by Kofi and Sena.', [KOFI]), ['Sena']);
    assert.deepEqual(uncoveredActors('Mei took over the Q3 roadmap from me.', []), ['Mei']);
    assert.deepEqual(uncoveredActors('Our CTO Tomás owns the sync.', []), ['Tomás']);
    assert.deepEqual(uncoveredActors('We use Stripe. I build Atlas.', []), []);
    assert.equal(mergeActorRetry([SELF], [SELF, KOFI, WRONG], ['Kofi']).length, 2);
  });
});

test('an EMPTY first reading of a sentence naming an actor is retried too (live: "Jun is helping me prepare the investor deck" → [])', async () => {
  __clearExtractionCache();
  const JUN = { ...base, subject: 'Jun', predicate: 'task_owner', object: { literal: 'prepare the investor deck' }, statementText: 'Jun is helping me prepare the investor deck' };
  const m = model({ first: [], hinted: [JUN] });
  const r = await run('Jun is helping me prepare the investor deck.', m);
  assert.equal(m.calls.length, 2);
  assert.deepEqual(r.claims.map(c => c.subject), ['Jun']);
  __clearExtractionCache();
  const quiet = model({ first: [] });
  await run('Thanks, that was helpful.', quiet);
  assert.equal(quiet.calls.length <= 1, true, 'no actor → no retry');
});
