import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterEpisodes } from './episodeCluster.js';

test('E9/PR-4 clusters nearby same-theme items and splits large gaps', () => {
  const out = clusterEpisodes({
    ownerId: 'owner:a',
    items: [
      { ownerId: 'owner:a', id: 'a', occurredAt: 1_000, theme: 'launch', subjects: ['A'] },
      { ownerId: 'owner:a', id: 'b', occurredAt: 20_000, theme: 'launch', subjects: ['A'] },
      { ownerId: 'owner:a', id: 'c', occurredAt: 3_000_000, theme: 'launch', subjects: ['A'] },
    ],
  });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].itemIds, ['a', 'b']);
  assert.equal(out[0].ownerId, 'owner:a');
});

test('E9/PR-4 refuses cross-owner clustering', () => {
  assert.throws(() => clusterEpisodes({
    ownerId: 'owner:a',
    items: [{ ownerId: 'owner:b', id: 'x', occurredAt: 1 }],
  }), /cannot mix owners/);
});
