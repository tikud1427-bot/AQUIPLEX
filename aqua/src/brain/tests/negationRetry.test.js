/**
 * The negation retry (2026-10-06): one extra, code-triggered attempt when a
 * sentence with an explicit negation cue reads as EMPTY. Production-extractor
 * E6 pass 2 lost "Nummo is not one of our customers" to an empty reading (pass
 * 1 extracted it), which alone failed the 95% negation gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runUnderstandingPipeline } from '../understanding/pipeline.js';
import { __clearExtractionCache } from '../understanding/extractionClient.js';

const claim = { subject: 'Nummo', predicate: 'related_to', object: { literal: 'one of our customers' }, objectKind: 'literal',
  polarity: 'negated', modality: 'fact', timePrecision: 'none', statementText: 'Nummo is not one of our customers' };
function model({ emptyFirst = true } = {}) {
  const calls = [];
  const fn = async ({ user }) => {
    calls.push(user);
    const hinted = /NOTE: this sentence contains a negation/.test(user);
    return { text: JSON.stringify({ claims: emptyFirst && !hinted ? [] : [claim] }), model: 'scripted' };
  };
  fn.calls = calls;
  return fn;
}

test('an empty reading of a negated sentence is retried once, with the reminder, and the claim kept', async () => {
  __clearExtractionCache();
  const callModel = model();
  const r = await runUnderstandingPipeline('Nummo is not one of our customers.', { callModel, assertedAt: '2026-10-06T00:00:00Z' });
  assert.equal(callModel.calls.length, 2);
  assert.equal(r.stats.negationRetries, 1);
  assert.equal(r.claims.length, 1);
  assert.equal(r.claims[0].polarity, 'negated');
});

test('no retry when the first reading found something, when there is no negation cue, or for a question', async () => {
  __clearExtractionCache();
  let m = model({ emptyFirst: false });
  await runUnderstandingPipeline('Nummo is not one of our customers.', { callModel: m, assertedAt: '2026-10-06T00:00:00Z' });
  assert.equal(m.calls.length, 1);
  __clearExtractionCache();
  m = model();
  await runUnderstandingPipeline('Nummo is one of our customers.', { callModel: m, assertedAt: '2026-10-06T00:00:00Z' });
  assert.equal(m.calls.length, 1, 'no negation cue → no retry');
  __clearExtractionCache();
  m = model();
  await runUnderstandingPipeline("Isn't Nummo one of our customers?", { callModel: m, assertedAt: '2026-10-06T00:00:00Z' });
  assert.ok(m.calls.length <= 1, 'a question is not retried');
});

test('the retry is bounded and still gated: a second empty reading stays empty', async () => {
  __clearExtractionCache();
  const calls = [];
  const callModel = async ({ user }) => { calls.push(user); return { text: '{"claims":[]}', model: 'scripted' }; };
  const r = await runUnderstandingPipeline("I don't know.", { callModel, assertedAt: '2026-10-06T00:00:00Z' });
  assert.ok(calls.length <= 2);
  assert.equal(r.claims.length, 0);
});
