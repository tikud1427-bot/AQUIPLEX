/**
 * E7 canonical semantic lane contract tests.
 *
 * These tests deliberately run with embeddings disabled. They pin the
 * identity/scope contract without requiring a provider call:
 *   fact.id is the vector identity;
 *   owner scopes are isolated;
 *   unavailable embeddings fail open.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalClaimNamespace,
  indexCanonicalClaim,
  indexCanonicalClaims,
  canonicalClaimScores,
} from '../contextEngine/canonicalSemantic.js';

describe('E7 canonical claim semantic lane', () => {
  test('namespace is owner-scoped and deterministic', () => {
    assert.equal(canonicalClaimNamespace('user:1'), 'canonical-claims:user:1');
    assert.equal(canonicalClaimNamespace('user:2'), 'canonical-claims:user:2');
    assert.notEqual(canonicalClaimNamespace('user:1'), canonicalClaimNamespace('user:2'));
  });

  test('disabled embeddings do not write or invent dense scores', async () => {
    const previous = process.env.AQUA_EMBEDDINGS;
    delete process.env.AQUA_EMBEDDINGS;
    try {
      const fact = { id: 'f123', statement: 'The billing project uses Postgres.' };
      assert.equal(await indexCanonicalClaim('user:test', fact), false);
      assert.deepEqual(
        await indexCanonicalClaims('user:test', [fact]),
        { indexed: 0, skipped: 0, removed: 0, enabled: false },
      );
      assert.equal(await canonicalClaimScores('user:test', 'billing database'), null);
    } finally {
      if (previous === undefined) delete process.env.AQUA_EMBEDDINGS;
      else process.env.AQUA_EMBEDDINGS = previous;
    }
  });
});
