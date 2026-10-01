import test from 'node:test';
import assert from 'node:assert/strict';
import { inferPatterns } from './patternInference.js';

const base = (id, episodeId, sourceId, overrides = {}) => ({
  ownerId: 'owner:a', claimId: id, episodeId, sourceId,
  subject: 'user', predicate: 'prefers', object: { literal: 'dark mode' }, polarity: 'asserted',
  ...overrides,
});

test('E9/PR-5 requires independent episodes and sources before proposing a pattern', () => {
  const proposals = inferPatterns({ ownerId: 'owner:a', claims: [
    base('c1', 'e1', 's1'), base('c2', 'e2', 's1'), base('c3', 'e3', 's2'),
  ] });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].proposedModality, 'inferred');
  assert.equal(proposals[0].confidenceCeiling, 0.45);
  assert.equal(proposals[0].evidenceClaimIds.length, 3);
});

test('E9/PR-5 does not infer from self-corroborating inferred claims or counter-polarity', () => {
  const inferred = inferPatterns({ ownerId: 'owner:a', claims: [
    base('i1', 'e1', 's1', { source: 'inference' }),
    base('i2', 'e2', 's2', { source: 'reflectionV3.patternInference@1' }),
    base('i3', 'e3', 's3', { sourceTier: 'inferred' }),
  ] });
  assert.equal(inferred.length, 0);

  const contradiction = inferPatterns({ ownerId: 'owner:a', claims: [
    base('c1', 'e1', 's1'), base('c2', 'e2', 's2'), base('c3', 'e3', 's3'),
    base('cx', 'e4', 's4', { polarity: 'negated' }),
  ] });
  assert.equal(contradiction.length, 0);
});
