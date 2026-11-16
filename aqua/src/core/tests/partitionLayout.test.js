/**
 * Partition layout — the split is lossless for every store shape (Phase 2a).
 *
 * Pure: no database, no files. The guarantee under test is the one the
 * rollback path depends on: reassemble(split(F)) parses to exactly F.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  splitStore, reassembleStore, canonicalChecksum, ownerForPartition,
  LAYOUTS, PARTITIONED_STORES, REST_KEY, GLOBAL_OWNER,
} from '../storage/partitionLayout.js';

const env = (data, extra = {}) => ({ __aqua: { schema: 1, savedAt: 1731400000000, ...extra }, data });

/** One realistic fixture per registered store, shaped like the module writes it. */
const FIXTURES = {
  '.aqua-mind.json': env({
    'user:1': { version: 2, facts: { name: { value: 'Ana', ts: 1 } }, tombstones: { facts: { city: 5 } } },
    'conv:abc': { version: 2, facts: {} },
  }, { deletedOwners: { 'user:9': 1731300000000 } }),
  '.aqua-evidence.json': env({ 'user:1': { items: [1, 2] }, anon: { items: [] } }),
  '.aqua-pic.json': env({ 'user:1': { lifecycle: {}, versions: {} } }),
  '.aqua-reasoning-graph.json': env({ 'user:1': { nodes: [{ id: 'self' }], edges: [] } }),
  '.aqua-ids.json': env({ 'user:1': { e1: { kind: 'person', canonical: 'Ana' } } }),
  '.aqua-brain.json': env({ 'user:2': { notes: ['x'] } }),
  '.aqua-reflection.json': env({ 'user:1': { lastAt: 3 } }),
  '.aqua-recall-redactions.json': env({ 'user:1': { r1: { at: 1 } } }),
  '.aqua-fileindex.json': env({ 'user:1': { terms: { rent: ['u1'] } } }),
  '.aqua-history.json': env({
    c1: { messages: [{ role: 'user', content: 'hi' }], meta: { userId: '42', title: 't' } },
    c2: { messages: [], meta: {} },
  }),
  '.aqua-history-trash.json': [
    { id: 'c9', deletedAt: 1, messages: [], meta: { userId: '42' } },
    { id: 'c9', deletedAt: 2, messages: [], meta: { userId: '42' } },   // deleted twice: kept twice
    { id: 'c8', deletedAt: 3, messages: [], meta: {} },
  ],
  '.aqua-attachments.json': env({ c1: [{ id: 'a1', name: 'rent.pdf', content: 'Rent: 6400' }] }),
  '.aqua-uko.json': env({
    owners: { 'user:1': { u1: { id: 'u1', hash: 'h1' } }, anon: {} },
    cache: { h1: { summary: 's' } },
  }),
  '.aqua-vectors.json': { 'user:1': { name: { vec: [0.1, 0.2], hash: 'h', ts: 1, dim: 2 } }, 'files:user:1': {} },
  '.aqua-projects.json': { ws1: { id: 'ws1', name: 'Repo' } },
  '.aqua-index.json': { ws1: [{ path: 'a.js', content: 'x' }] },
  '.index.json': { art1: { id: 'art1', ownerId: 'user:1', format: 'pdf' }, art2: { id: 'art2', ownerId: null } },
  '.aqua-artifacts.json': { art1: { id: 'art1', ownerId: 'user:1', format: 'pdf', manifest: { id: 'art1', version: 1, versions: [{ v: 1, dir: 'v1-ab' }] } } },
  '.aqua-cognition.json': { version: 1, byTask: { chat: { n: 3 } }, updatedAt: 5 },
  '.aqua-ledger.json': { version: 2, byTask: {}, updatedAt: null },
  '.aqua-identity-overrides.json': { name: 'AQUA' },
};

const roundTrip = (storeKey, value, { pretty = false } = {}) => {
  const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  const { partitions } = splitStore(storeKey, text);
  return { text, partitions, back: reassembleStore(storeKey, partitions) };
};

describe('partition layout — lossless for every registered store', () => {
  test('every registered store has a fixture (a new store must add one)', () => {
    assert.deepEqual([...PARTITIONED_STORES].sort(), Object.keys(FIXTURES).sort());
  });

  for (const storeKey of Object.keys(FIXTURES)) {
    test(`${storeKey}: reassemble(split(F)) deep-equals F, key order kept`, () => {
      const { text, back, partitions } = roundTrip(storeKey, FIXTURES[storeKey]);
      assert.deepEqual(JSON.parse(back), JSON.parse(text));
      assert.equal(back, text, 'compact source → identical text (order preserved)');
      assert.equal(partitions.at(-1).partitionKey, REST_KEY, '~rest is always present and last');
    });
  }

  test('a pretty-printed source comes back equal in content (bytes are not promised)', () => {
    const { text, back } = roundTrip('.aqua-projects.json', FIXTURES['.aqua-projects.json'], { pretty: true });
    assert.notEqual(back, text);
    assert.equal(canonicalChecksum(back), canonicalChecksum(text));
  });

  test('order is restored from ordinal even when rows arrive shuffled', () => {
    const text = JSON.stringify(FIXTURES['.aqua-history.json']);
    const { partitions } = splitStore('.aqua-history.json', text);
    const shuffled = [...partitions].reverse();
    assert.equal(reassembleStore('.aqua-history.json', shuffled), text);
  });

  test('an unknown store is one ~rest partition: exactly the blob it was', () => {
    const value = { anything: [1, { b: 2 }] };
    const { partitions, back } = roundTrip('.aqua-not-registered.json', value);
    assert.equal(partitions.length, 1);
    assert.deepEqual(JSON.parse(back), value);
  });

  test('a legacy bare file of an envelope store still splits by owner and round-trips', () => {
    const bare = { 'user:1': { facts: {} }, 'user:2': { facts: { a: 1 } } };
    const { partitions, back } = roundTrip('.aqua-mind.json', bare);
    assert.deepEqual(partitions.map(p => p.partitionKey), ['o:user:1', 'o:user:2', REST_KEY]);
    assert.deepEqual(JSON.parse(back), bare);
  });

  test('a section that is missing from the file is not invented on the way back', () => {
    const noCache = env({ owners: { 'user:1': {} } });
    const { back } = roundTrip('.aqua-uko.json', noCache);
    assert.deepEqual(JSON.parse(back), noCache);
    assert.equal('cache' in JSON.parse(back).data, false);
  });

  test('a store whose data is not an object keeps it all in ~rest', () => {
    const odd = env(null);
    const { partitions, back } = roundTrip('.aqua-mind.json', odd);
    assert.equal(partitions.length, 1);
    assert.deepEqual(JSON.parse(back), odd);
  });

  test('a key named __proto__ survives (no prototype assignment)', () => {
    const text = '{"__aqua":{"schema":1,"savedAt":1},"data":{"__proto__":{"facts":{"x":1}},"user:1":{}}}';
    const { partitions } = splitStore('.aqua-mind.json', text);
    const back = JSON.parse(reassembleStore('.aqua-mind.json', partitions));
    assert.deepEqual(Object.keys(back.data), ['__proto__', 'user:1']);
    assert.deepEqual(back.data.__proto__, { facts: { x: 1 } });
    assert.equal(reassembleStore('.aqua-mind.json', partitions), text);
  });

  test('empty stores round-trip', () => {
    for (const v of [env({}), {}, []]) {
      const key = Array.isArray(v) ? '.aqua-history-trash.json' : '.aqua-mind.json';
      assert.deepEqual(JSON.parse(roundTrip(key, v).back), v);
    }
  });

  test('without a ~rest row (a store born in partitions) the result is a bare map every loader accepts', () => {
    const back = reassembleStore('.aqua-mind.json', [{ partitionKey: 'o:user:1', data: '{"facts":{}}', ordinal: null }]);
    assert.deepEqual(JSON.parse(back), { 'user:1': { facts: {} } });
  });
});

describe('partition layout — owner derivation', () => {
  const owners = (storeKey) => {
    const { partitions } = splitStore(storeKey, JSON.stringify(FIXTURES[storeKey]));
    return Object.fromEntries(partitions.map(p => [p.partitionKey, p.ownerId]));
  };

  test('owner-keyed stores: the key is the owner', () => {
    assert.deepEqual(owners('.aqua-mind.json'), { 'o:user:1': 'user:1', 'o:conv:abc': 'conv:abc', [REST_KEY]: GLOBAL_OWNER });
  });

  test('conversations: meta.userId → user:<id>, pre-login → conv:<id>', () => {
    // Phase 2b: a header row per conversation and one row per message, owned alike.
    assert.deepEqual(owners('.aqua-history.json'), { 'c:c1': 'user:42', 'm:c1:0-000000': 'user:42', 'c:c2': 'conv:c2', [REST_KEY]: GLOBAL_OWNER });
  });

  test('trash keeps duplicates as separate partitions, owned by their user', () => {
    const o = owners('.aqua-history-trash.json');
    assert.deepEqual(Object.keys(o), ['t:000000:c9', 't:000001:c9', 't:000002:c8', REST_KEY]);
    assert.equal(o['t:000000:c9'], 'user:42');
    assert.equal(o['t:000002:c8'], 'conv:c8');
  });

  test('uko: owner section by owner, content cache is global', () => {
    const o = owners('.aqua-uko.json');
    assert.equal(o['owners:user:1'], 'user:1');
    assert.equal(o['cache:h1'], GLOBAL_OWNER);
  });

  test('vectors: files:<owner> namespaces belong to the owner', () => {
    const o = owners('.aqua-vectors.json');
    assert.equal(o['ns:user:1'], 'user:1');
    assert.equal(o['ns:files:user:1'], 'user:1');
  });

  test('artifacts: the entry names its owner; an unowned artifact is global', () => {
    const o = owners('.index.json');
    assert.equal(o['a:art1'], 'user:1');
    assert.equal(o['a:art2'], GLOBAL_OWNER);
  });

  test('global aggregates are not owner data', () => {
    for (const k of ['.aqua-cognition.json', '.aqua-ledger.json']) {
      assert.deepEqual(owners(k), { [REST_KEY]: GLOBAL_OWNER });
      assert.deepEqual(LAYOUTS[k], []);
    }
  });

  test('ownerForPartition agrees with the split for new writes', () => {
    assert.equal(ownerForPartition('.aqua-history.json', 'c:new', { meta: { userId: '7' } }), 'user:7');
    assert.equal(ownerForPartition('.aqua-mind.json', 'o:user:3', {}), 'user:3');
    assert.equal(ownerForPartition('.aqua-mind.json', REST_KEY, {}), GLOBAL_OWNER);
  });

  test('one owner\'s partitions never contain another owner\'s data', () => {
    for (const storeKey of Object.keys(FIXTURES)) {
      const { partitions } = splitStore(storeKey, JSON.stringify(FIXTURES[storeKey]));
      for (const p of partitions) {
        if (!p.ownerId.startsWith('user:')) continue;
        for (const other of ['user:1', 'user:2', 'user:42', 'user:9'].filter(o => o !== p.ownerId)) {
          assert.equal(p.data.includes(`"${other}"`), false, `${storeKey} ${p.partitionKey} mentions ${other}`);
        }
      }
    }
  });
});
