/**
 * E8 root-cause regression — sentence-final punctuation must not fuse to a token.
 *
 * Found by tracing why the Context Engine ranked the same two high-confidence
 * "document" facts first for every query: `tokensOf` returned "co-founder." for
 * a stored sentence and "co-founder" for the question, so the answer word never
 * matched and user_focus/semantic_similarity (0.36 of the weight) read 0.
 *
 * BITE (measured): restore the old `m[0]` (no trim) → 4 of 5 tests fail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokensOf, scoreCandidate } from './scorer.js';

test('a sentence-final period does not become part of the last word', () => {
  assert.ok(tokensOf('Chhanda is my co-founder.').has('co-founder'));
  assert.ok(!tokensOf('Chhanda is my co-founder.').has('co-founder.'));
});

test('internal dots and hyphens are kept (versions, hostnames, compounds)', () => {
  const t = tokensOf('Using node.js v1.2 with a co-founder');
  for (const w of ['node.js', 'v1.2', 'co-founder']) assert.ok(t.has(w), w);
});

test('trailing ellipses and dangling hyphens are trimmed too', () => {
  const t = tokensOf('well... then a-b- and c.');
  assert.ok(t.has('well') && t.has('a-b'));
  assert.ok(![...t].some(x => /[.\-]$/.test(x)));
});

test('a fact and a question about it now overlap on the answer word', () => {
  const q = tokensOf('Who is my co-founder?');
  const on = scoreCandidate({ id: 'a', text: 'Chhanda is my co-founder.', confidence: 0.6, sourceType: 'conversation' }, { queryTokens: q });
  const off = scoreCandidate({ id: 'b', text: 'I run product at Nummo.', confidence: 0.6, sourceType: 'conversation' }, { queryTokens: q });
  assert.ok(on.dimensions.user_focus > 0);
  assert.ok(on.dimensions.semantic_similarity > 0);
  assert.ok(on.score > off.score, 'the fact that answers the question must outscore one that does not');
});

test('a high-confidence document fact does not beat an on-topic conversation fact', () => {
  const q = tokensOf('Who is my co-founder?');
  const answer = scoreCandidate({ id: 'a', text: 'Chhanda is my co-founder.', confidence: 0.6, sourceType: 'conversation' }, { queryTokens: q });
  const prior = scoreCandidate({ id: 'b', text: 'We are building AQUA, a cognitive AI operating system.', confidence: 0.9, sourceType: 'document' }, { queryTokens: q });
  assert.ok(answer.score > prior.score, `${answer.score} vs ${prior.score}`);
});
