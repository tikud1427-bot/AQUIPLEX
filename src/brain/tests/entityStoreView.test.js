/**
 * The S6 entity reader — a VIEW over the canonical identity map
 * Blueprint E6/S6 · L2 (one atom, many read models) · L8 · L19
 *
 * S6 was unreachable because `understandTurn` passed no `entityStore`. The
 * temptation was to build one. This file pins the decision not to: the reader
 * holds nothing, writes nothing, and reads the map that already exists.
 *
 * BITE, MEASURED (revert the named property → count failures):
 *   the view writes nothing            → 2 fail
 *   owner scoping                      → 2 fail
 *   `byAlias` deliberately absent      → 1 fail
 *   normalisation keyspaces agree      → 1 fail
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { entityStoreFor } from '../identity/entityStoreView.js';
import * as idStore from '../identity/idStore.js';
import * as canonicalIds from '../identity/canonicalId.js';
import { SELF_CANONICAL_ID, SELF_KIND, SELF_LABEL } from '../identity/selfEntity.js';
import { normalizeMention } from '../../reasoning/entityResolver.js';

beforeEach(() => { idStore._resetIdsForTests(); });

describe('the S6 entity reader is a view, not a store', () => {
  test('it holds no state of its own — two views over one owner see the same world', () => {
    canonicalIds.resolve('o1', { name: 'Nummo', kind: 'org' });
    const a = entityStoreFor('o1');
    const b = entityStoreFor('o1');
    assert.equal(a.all().length, 1);
    assert.deepEqual(a.byNormalized(normalizeMention('Nummo')), b.byNormalized(normalizeMention('Nummo')));
  });

  test('READING DOES NOT WRITE — the map is byte-identical after a full read', async () => {
    // `canonicalId.lookup()` looks like the natural reuse and is not: resolve()
    // calls putEntry on its exact and merge paths BEFORE returning, so a
    // "lookup" bumps `updatedAt`, unions norms and can upgrade a kind. A shadow
    // stage must not change the world it is measuring.
    //
    // ⚠️ THE SLEEP IS LOAD-BEARING, and it is here because the first version of
    // this test did not bite. `putEntry` stamps `updatedAt: Date.now()`; seeding
    // and reading inside the same millisecond produced an identical snapshot,
    // so a deliberately-writing reader passed 10/10. A test that survives the
    // defect it guards is not a test (L16). Five milliseconds makes the stamp
    // move deterministically on any write at all.
    canonicalIds.resolve('o1', { name: 'Nummo', kind: 'org' });
    await new Promise(r => setTimeout(r, 5));
    const before = JSON.stringify([...idStore.allEntries('o1')]);

    const view = entityStoreFor('o1');
    view.byNormalized(normalizeMention('Nummo'));          // exact hit — the write path
    view.byNormalized(normalizeMention('Something Absent')); // miss
    view.all();

    assert.equal(JSON.stringify([...idStore.allEntries('o1')]), before,
      'the reader mutated the identity map — an exact hit went through a write path');
  });

  test('a miss creates nothing — no provisional entry is minted by looking', () => {
    canonicalIds.resolve('o1', { name: 'Nummo', kind: 'org' });
    entityStoreFor('o1').byNormalized(normalizeMention('Zebedee Holdings'));
    assert.equal(idStore.allEntries('o1').size, 1, 'a lookup minted an entity');
  });
});

describe('the S6 entity reader is owner-scoped (L19)', () => {
  test('one owner cannot see another owner\'s entities', () => {
    canonicalIds.resolve('owner-a', { name: 'Nummo', kind: 'org' });
    canonicalIds.resolve('owner-b', { name: 'Contoso', kind: 'org' });

    const a = entityStoreFor('owner-a');
    assert.equal(a.byNormalized(normalizeMention('Contoso')), null, 'cross-owner read');
    assert.deepEqual(a.all().map(e => e.name), ['Nummo']);
  });

  test('no owner means no view — S6 then does not run, which is the right fail-open', () => {
    assert.equal(entityStoreFor(null), null);
    assert.equal(entityStoreFor(''), null);
  });
});

describe('the S6 entity reader tells the truth about its tiers', () => {
  test('byAlias is ABSENT, because idStore has no separate alias space', () => {
    // Every spelling — canonical and alias alike — lives in the same `norms`
    // array and the same index, so tier ① already returns what tier ② would
    // look for. A byAlias over that index would report ALIAS for what is an
    // EXACT match, and `stats.s6.byTier` is the only evidence anyone has that
    // S6 did anything. S6 reads an absent optional reader as null.
    const view = entityStoreFor('o1');
    assert.equal(view.byAlias, undefined,
      'a byAlias that consults the exact index would mislabel the tier it reports');
  });

  test('an alias registered on an entry resolves through tier ① — not lost', () => {
    // Absent byAlias must not mean absent alias COVERAGE. This is the assertion
    // that keeps the honesty above from becoming a capability gap.
    const { id } = canonicalIds.resolve('o1', { name: 'Nummo', kind: 'org' });
    idStore.putEntry('o1', id, { norms: [normalizeMention('Nummo Labs')] });

    const hit = entityStoreFor('o1').byNormalized(normalizeMention('Nummo Labs'));
    assert.equal(hit?.entityId, id, 'an alias spelling did not resolve');
  });

  test('THE KEYSPACE ACTUALLY MEETS — writer and reader normalise identically', () => {
    // Blueprint §10: "a semantic embedding is useless if embedding key ≠
    // retrieval identity." This file lives one seam away from repeating that,
    // and the failure would be silent — every lookup missing, S6 reporting a
    // resolution rate of zero that reads like a measurement of the resolver.
    canonicalIds.resolve('o1', { name: 'Nummo Inc.', kind: 'org' });
    const view = entityStoreFor('o1');
    assert.ok(view.byNormalized(normalizeMention('nummo inc')), 'writer and reader disagree on normalisation');
    assert.ok(view.byNormalized(normalizeMention('NUMMO INC.')), 'casing broke the lookup');
  });
});

describe('the self entity stays name-unreachable through the view (L8)', () => {
  test('"You" does not resolve by name — the never-fuse invariant survives', () => {
    // `ensureSelfEntity` registers the self entry with NO norms precisely so it
    // is reachable by id and unreachable by name. The view must not undo that
    // by exposing `canonical` to a name lookup.
    idStore.putEntry('o1', SELF_CANONICAL_ID, {
      kind: SELF_KIND, canonical: SELF_LABEL, norms: [], refs: [],
    });
    const view = entityStoreFor('o1');
    assert.equal(view.byNormalized(normalizeMention('You')), null);
    assert.equal(view.byNormalized(normalizeMention('you')), null);
  });

  test('but it IS visible to the candidate scan, which is how S6 sees the world', () => {
    idStore.putEntry('o1', SELF_CANONICAL_ID, {
      kind: SELF_KIND, canonical: SELF_LABEL, norms: [], refs: [],
    });
    const ids = entityStoreFor('o1').all().map(e => e.entityId);
    assert.ok(ids.includes(SELF_CANONICAL_ID));
  });
});
