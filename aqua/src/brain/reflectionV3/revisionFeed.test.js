import test from 'node:test';
import assert from 'node:assert/strict';
import { mapRevision, readCanonicalRevisionFeed, getRevisionFeed } from './revisionFeed.js';

test('canonical revision rows map to the stable change-feed shape', () => {
  const out = mapRevision({
    revision_id: 'r1',
    target_kind: 'claim',
    target_id: 'c1',
    change_kind: 'update',
    before: { state: 'active' },
    after: { predicate: 'works_at' },
    reason: 'user-correction',
    actor: 'user',
    source: 'user-correction',
    reversible: true,
    created_at: '2026-09-28T00:00:00.000Z',
  });
  assert.equal(out.id, 'r1');
  assert.equal(out.revised, 1);
  assert.equal(out.applied, true);
  assert.equal(out.actor, 'user');
  assert.match(out.summary, /updated works_at/);
});

test('canonical feed is structurally owner-scoped and bounded', async () => {
  const calls = [];
  const rows = await readCanonicalRevisionFeed('owner:a', {
    limit: 999,
    dbPool: { query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ revision_id: 'r1', target_kind: 'claim', target_id: 'c1', change_kind: 'create', created_at: 1 }] };
    } },
  });
  assert.equal(rows.length, 1);
  assert.match(calls[0].sql, /WHERE owner_id = \$1/);
  assert.equal(calls[0].params[0], 'owner:a');
  assert.equal(calls[0].params[1], 100);
});

test('canonical feed wins when present; legacy remains a compatibility fallback', async () => {
  const canonical = await getRevisionFeed('owner:a', {
    canonicalReader: async () => [{ id: 'r1' }],
    legacyReader: async () => [{ id: 'legacy' }],
  });
  assert.equal(canonical.source, 'canonical');
  assert.deepEqual(canonical.changes, [{ id: 'r1' }]);

  const fallback = await getRevisionFeed('owner:a', {
    canonicalReader: async () => [],
    legacyReader: async () => [{ id: 'legacy' }],
  });
  assert.equal(fallback.source, 'legacy');
  assert.deepEqual(fallback.changes, [{ id: 'legacy' }]);
});
