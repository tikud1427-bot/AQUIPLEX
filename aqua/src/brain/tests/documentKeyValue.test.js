import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { keyValueClaim, runUnderstandingPipeline } from '../understanding/pipeline.js';

// Pass 2 (2026-10-11): contract constraints in an uploaded document must reach
// the World Model even when the extractor returns nothing for the line.
describe('document key/value fallback', () => {
  test('a Key: value line becomes key has_property value, verbatim', () => {
    assert.deepEqual(keyValueClaim('Cap: 12 days per month.'), { subject: 'Cap', predicate: 'has_property', object: { literal: '12 days per month' },
      polarity: 'asserted', modality: 'fact', timePrecision: 'none', statementText: 'Cap: 12 days per month' });
    assert.equal(keyValueClaim('Out of scope: mobile app changes, analytics dashboards.').object.literal, 'mobile app changes, analytics dashboards');
  });
  test('prose, long keys and URLs are not key/value lines', () => {
    assert.equal(keyValueClaim('We met at the cafe and talked about the contract terms.'), null);
    assert.equal(keyValueClaim('This is a very long label that goes on: value'), null);
    assert.equal(keyValueClaim('https://example.com/x'), null);
  });

  test('on the pipeline: used ONLY for documents, and only when the model gives nothing — still validated', async () => {
    const empty = async () => ({ text: JSON.stringify({ claims: [] }), model: 'stub' });
    const doc = await runUnderstandingPipeline('Cap: 12 days per month.', { ownerId: 'user:t', callModel: empty, documentFallback: true });
    assert.deepEqual(doc.claims.map(c => [c.subject, c.predicate, c.object.literal]), [['Cap', 'has_property', '12 days per month']]);
    const chat = await runUnderstandingPipeline('Cap: 12 days per month.', { ownerId: 'user:t', callModel: empty });
    assert.equal(chat.claims.length, 0, 'chat turns never get the fallback');
    const real = async () => ({ text: JSON.stringify({ claims: [{ subject: 'Mellow', predicate: 'has_property', object: { literal: 'a cap of 14 days per month' },
      polarity: 'asserted', modality: 'fact', timePrecision: 'none', statementText: 'Mellow billing: a cap of 14 days per month' }] }), model: 'stub' });
    const withModel = await runUnderstandingPipeline('Mellow billing: a cap of 14 days per month.', { ownerId: 'user:t', callModel: real, documentFallback: true });
    assert.equal(withModel.claims.length, 1);
    assert.equal(withModel.claims[0].subject, 'Mellow', 'the model\'s own reading wins when it has one');
  });
});
