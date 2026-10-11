/**
 * The canonical lexical lane matches ANY content word of a question (2026-10-06).
 * It used to AND every word (stopwords included) and contributed zero items to
 * a full World-Model Lift run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lexicalTerms } from './canonicalReadModel.js';

test('content words only — stopwords and question words dropped', () => {
  assert.deepEqual(lexicalTerms('Who is my tech lead going forward?'), ['tech', 'lead', 'forward']);
});
test('safe for to_tsquery: letters/digits only, bounded, deduplicated', () => {
  const t = lexicalTerms("O'Brien's & (launch) | launch: v2.0 !!");
  assert.ok(t.every(x => /^[\p{L}\p{N}]+$/u.test(x)), JSON.stringify(t));
  assert.equal(new Set(t).size, t.length);
  assert.ok(lexicalTerms('a b c d e f g h i j k l m n o p alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi').length <= 12);
});
test('a question of only stopwords yields nothing (the lane abstains)', () => {
  assert.deepEqual(lexicalTerms('What is it?'), []);
});
