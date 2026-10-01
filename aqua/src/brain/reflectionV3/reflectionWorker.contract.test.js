import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('E9 — reflection worker calls the canonical claim loader with owner first', () => {
  const src = fs.readFileSync(new URL('./reflectionWorker.js', import.meta.url), 'utf8');
  assert.match(src, /loadClaim\(ownerId, claimId\)/);
  assert.doesNotMatch(src, /loadClaim\(claimId, ownerId\)/);
});
