/**
 * The compound-change retry (2026-10-17): one extra, code-triggered attempt
 * when a clause of a sentence states a change and no extracted claim covers
 * it. Measured on the real product (founder journey runs 3 and 4): "we moved
 * the launch to May 2, and the price is now $39" kept only one of its two
 * changes, a different one each run.
 *
 * The live base miss rate is low (1 of 16 change clauses on an 8-sentence
 * development battery, retry off), so these scripted tests are what pin the
 * mechanism; the live battery could not exercise it (no miss with retry on).
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runUnderstandingPipeline, uncoveredChangeClauses, mergeCompoundRetry } from '../understanding/pipeline.js';
import { __clearExtractionCache } from '../understanding/extractionClient.js';

const SENTENCE = 'Update: we moved the launch to May 2, and the price is now $39 per clinic per month.';
const base = { polarity: 'asserted', modality: 'fact', timePrecision: 'none', revises: true };
const PRICE = { ...base, subject: 'self', predicate: 'has_property', object: { literal: '$39 per clinic per month' }, statementText: 'the price is now $39 per clinic per month' };
const LAUNCH = { ...base, subject: 'launch', predicate: 'deadline_for', object: { literal: 'May 2' }, timePrecision: 'day', statementText: 'we moved the launch to May 2' };

function model({ first = [PRICE], hinted = [PRICE, LAUNCH] } = {}) {
  const calls = [];
  const fn = async ({ user }) => {
    calls.push(user);
    const isRetry = /NOTE: this sentence states more than one thing/.test(user);
    return { text: JSON.stringify({ claims: isRetry ? hinted : first }), model: 'scripted' };
  };
  fn.calls = calls;
  return fn;
}
const run = (text, callModel) => runUnderstandingPipeline(text, { callModel, assertedAt: '2026-10-17T00:00:00Z' });

describe('compound-change retry (opt-in: AQUA_E6_COMPOUND_RETRY=on)', () => {
  beforeEach(() => { process.env.AQUA_E6_COMPOUND_RETRY = 'on'; });
  afterEach(() => { delete process.env.AQUA_E6_COMPOUND_RETRY; __clearExtractionCache(); });

  test('a dropped change is asked for once, by name, and both changes are kept', async () => {
    __clearExtractionCache();
    const m = model();
    const r = await run(SENTENCE, m);
    assert.equal(m.calls.length, 2);
    assert.match(m.calls[1], /no claim for this part of it: "Update: we moved the launch to May 2"/);
    assert.equal(r.stats.compoundRetries, 1);
    assert.equal(r.stats.compoundRecovered, 1);
    assert.deepEqual(r.claims.map(c => c.predicate).sort(), ['deadline_for', 'has_property']);
  });

  test('no retry when every change is covered, for a single clause, without change language, or for a question', async () => {
    for (const [text, first] of [
      [SENTENCE, [PRICE, LAUNCH]],
      ['We moved the launch to May 2.', [LAUNCH]],
      ['We use Stripe for billing, and our backend is written in Elixir.', [{ ...PRICE, predicate: 'uses', object: { entity: 'Stripe' }, statementText: 'We use Stripe for billing' }]],
      ['Did we move the launch to May 2, and is the price now $39?', [PRICE]],
    ]) {
      __clearExtractionCache();
      const m = model({ first });
      await run(text, m);
      assert.equal(m.calls.length, 1, text);
    }
  });

  test('the second reading cannot replace what the first one extracted', async () => {
    __clearExtractionCache();
    // The retry re-reads the price differently; only the claim covering the
    // missing clause is taken from it.
    const m = model({ hinted: [{ ...PRICE, object: { literal: '$45 per clinic per month' } }, LAUNCH] });
    const r = await run(SENTENCE, m);
    const literals = r.claims.map(c => c.object?.literal ?? c.object?.value).filter(Boolean);
    assert.ok(literals.some(l => /\$39/.test(l)), JSON.stringify(literals));
    assert.ok(!literals.some(l => /\$45/.test(l)), 'the re-read of an already-covered clause must not be added');
  });

  test('off by default (no measured benefit) and with =off', async () => {
    delete process.env.AQUA_E6_COMPOUND_RETRY;
    __clearExtractionCache();
    const m = model();
    const r = await run(SENTENCE, m);
    assert.equal(m.calls.length, 1);
    assert.equal(r.claims.length, 1);
  });

  test('coverage helpers', () => {
    assert.deepEqual(uncoveredChangeClauses(SENTENCE, [PRICE, LAUNCH]), []);
    assert.deepEqual(uncoveredChangeClauses(SENTENCE, [LAUNCH]), ['the price is now $39 per clinic per month']);
    assert.deepEqual(uncoveredChangeClauses('We pushed the beta to June 3 and hired Wren as our first support lead.',
      [{ statementText: 'We pushed the beta to June 3' }]), ['hired Wren as our first support lead']);
    assert.equal(mergeCompoundRetry([PRICE], [PRICE, LAUNCH], ['we moved the launch to May 2']).length, 2);
  });
});

// 2026-10-18: two recordings of "We're now at 57 paying clinics" — one set
// `revises`, one did not; without it the old count stayed current.
describe('revises from rule 11 cues', () => {
  test('a change cue in the claim span sets revises (marked inferred); an ordinary statement does not', async () => {
    const { inferRevises } = await import('../understanding/pipeline.js');
    const c = inferRevises({ predicate: 'has_property', modality: 'fact', statementText: "We're now at 57 paying clinics" });
    assert.equal(c.revises, true);
    assert.equal(c.revisesInferred, true);
    assert.equal(inferRevises({ modality: 'fact', statementText: 'We have 42 paying clinics' }).revises, undefined);
    assert.equal(inferRevises({ modality: 'intent', statementText: 'We now plan to hire' }).revises, undefined, 'an intent is not a change of fact');
    const explicit = { modality: 'fact', statementText: 'x', revises: true };
    assert.equal(inferRevises(explicit), explicit);
  });
});
