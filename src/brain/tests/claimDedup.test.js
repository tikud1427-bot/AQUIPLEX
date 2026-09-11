/**
 * E6/PR-9 — dedup, corroboration & contradiction (S8).
 *
 * Two claims carry most of the weight:
 *
 *   1. S8 DETECTS AND REFUSES TO DECIDE. Both contradicting claims survive.
 *      A stage that quietly resolved would leave one surviving row looking
 *      like a fact nobody ever disputed.
 *   2. IT DOES NOT OVER-FIRE. FINDING-1 exists because a contradiction rule
 *      fired on ordinary variation. "I use Postgres" and "I use Redis" must
 *      not accuse the user of disagreeing with themselves.
 *
 * Run: node --test src/brain/tests/claimDedup.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  exactKey, subjectPredicateKey, validityOverlaps, sameClaim,
  contradictionBetween, dedupAndDetect,
} from '../understanding/claimDedup.js';

const claim = (over = {}) => ({
  subject: 'self',
  predicate: 'works_at',
  object: { entity: 'Nummo' },
  objectKind: 'entity',
  polarity: 'asserted',
  modality: 'fact',
  validFrom: null,
  validTo: null,
  sourceTier: 'chat',
  claimId: 'c1',
  ...over,
});

describe('S8 — exact dedup is corroboration, not a second row', () => {
  test('the same fact said twice is ONE claim with two sources', () => {
    // Storing it twice makes repetition look like independent corroboration
    // and inflates every count that reads the store.
    const r = dedupAndDetect([claim({ claimId: 'c1' }), claim({ claimId: 'c2' })]);
    assert.equal(r.claims.length, 1);
    assert.equal(r.claims[0].corroborationCount, 2);
    assert.equal(r.stats.corroborated, 1);
  });

  test('polarity is part of identity — asserted and negated are different claims', () => {
    assert.notEqual(exactKey(claim({ polarity: 'asserted' })), exactKey(claim({ polarity: 'negated' })));
  });

  test('object KIND is part of identity, so 5 and "5" do not collapse', () => {
    assert.notEqual(
      exactKey(claim({ object: { quantity: 5 }, objectKind: 'quantity' })),
      exactKey(claim({ object: { literal: '5' }, objectKind: 'literal' })));
  });

  test('MODALITY is out of the key but still separates claims', () => {
    // "I plan to join Zeta" and "I joined Zeta" share subject, predicate and
    // object. They must not collapse — but they must still land in the same
    // bucket so they can be COMPARED. Keeping modality out of the key and
    // checking it in sameClaim does both.
    const a = claim({ modality: 'fact' }), b = claim({ modality: 'intent' });
    assert.equal(exactKey(a), exactKey(b), 'same bucket');
    assert.equal(sameClaim(a, b), false, 'but not the same claim');

    const r = dedupAndDetect([a, b]);
    assert.equal(r.stats.corroborated, 0, 'an intent does not corroborate a fact');
  });

  test('case and whitespace do not create duplicates', () => {
    const r = dedupAndDetect([claim(), claim({ subject: '  SELF  ', object: { entity: 'nummo' } })]);
    assert.equal(r.claims.length, 1);
  });
});

describe('S8 — the survivor is the higher source tier', () => {
  test('a document absorbs chat', () => {
    const r = dedupAndDetect([
      claim({ sourceTier: 'chat', claimId: 'c1' }),
      claim({ sourceTier: 'file', claimId: 'c2' }),
    ]);
    assert.equal(r.claims.length, 1);
    assert.equal(r.claims[0].sourceTier, 'file');
    assert.equal(r.claims[0].corroborationCount, 2, 'the absorbed claim still counts as corroboration');
  });

  test('chat does NOT absorb a document', () => {
    const r = dedupAndDetect([
      claim({ sourceTier: 'file', claimId: 'c1' }),
      claim({ sourceTier: 'chat', claimId: 'c2' }),
    ]);
    assert.equal(r.claims[0].sourceTier, 'file');
  });

  test('a TIE keeps the incumbent — re-ingest must not churn the store', () => {
    const r = dedupAndDetect([
      claim({ sourceTier: 'chat', claimId: 'first' }),
      claim({ sourceTier: 'chat', claimId: 'second' }),
    ]);
    assert.equal(r.claims[0].claimId, 'first');
  });

  test('an unknown tier never outranks a known one', () => {
    const r = dedupAndDetect([claim({ sourceTier: 'file' }), claim({ sourceTier: 'nonsense' })]);
    assert.equal(r.claims[0].sourceTier, 'file');
  });
});

describe('S8 — validity overlap, and the nulls that decide it', () => {
  const w = (from, to) => ({ validFrom: from, validTo: to });

  test('two unbounded claims overlap', () => {
    assert.equal(validityOverlaps(w(null, null), w(null, null)), true);
  });

  test('an unbounded end overlaps anything after its start', () => {
    assert.equal(validityOverlaps(w('2024-01-01T00:00:00Z', null), w('2026-01-01T00:00:00Z', null)), true);
  });

  test('adjacent-but-disjoint windows do NOT overlap', () => {
    // "I worked at Intercom until 2024" and "I work at Nummo since 2025" are a
    // career, not a conflict.
    assert.equal(validityOverlaps(
      w('2020-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
      w('2025-01-01T00:00:00Z', null)), false);
  });

  test('touching windows DO overlap', () => {
    assert.equal(validityOverlaps(
      w('2020-01-01T00:00:00Z', '2024-06-01T00:00:00Z'),
      w('2024-06-01T00:00:00Z', null)), true);
  });

  test('an UNPARSEABLE date is unbounded, not NaN', () => {
    // NaN comparisons are all false, which would silently report NO overlap
    // and hide every contradiction involving a malformed date — a failure that
    // makes the store look cleaner than it is.
    assert.equal(validityOverlaps(w('not-a-date', null), w('2026-01-01T00:00:00Z', null)), true);
  });
});

describe('S8 — contradiction: opposite polarity', () => {
  test('asserted vs negated on the same object, overlapping validity', () => {
    const v = contradictionBetween(
      claim({ polarity: 'asserted' }), claim({ polarity: 'negated' }));
    assert.equal(v.contradicts, true);
    assert.equal(v.kind, 'polarity');
  });

  test('needs no cardinality knowledge — fires on a multi-valued predicate too', () => {
    const a = claim({ predicate: 'uses', object: { literal: 'Postgres' }, objectKind: 'literal' });
    const b = { ...a, polarity: 'negated' };
    assert.equal(contradictionBetween(a, b).contradicts, true);
  });

  test('opposite polarity on DIFFERENT objects is not a contradiction', () => {
    // "I use Postgres" and "I do not use Redis" are both true.
    const a = claim({ predicate: 'uses', object: { literal: 'Postgres' }, objectKind: 'literal' });
    const b = claim({ predicate: 'uses', object: { literal: 'Redis' }, objectKind: 'literal', polarity: 'negated' });
    assert.equal(contradictionBetween(a, b).contradicts, false);
  });

  test('DISJOINT validity means no contradiction', () => {
    const a = claim({ validFrom: '2020-01-01T00:00:00Z', validTo: '2024-01-01T00:00:00Z' });
    const b = claim({ polarity: 'negated', validFrom: '2025-01-01T00:00:00Z' });
    const v = contradictionBetween(a, b);
    assert.equal(v.contradicts, false);
    assert.equal(v.reason, 'disjoint-validity');
  });

  test('an INTENT does not contradict a fact', () => {
    // "I plan to leave Nummo" does not disagree with "I work at Nummo" —
    // it explains it.
    const v = contradictionBetween(claim({ modality: 'fact' }),
      claim({ modality: 'intent', polarity: 'negated' }));
    assert.equal(v.contradicts, false);
    assert.equal(v.reason, 'non-factual-modality');
  });
});

describe('S8 — contradiction: incompatible object is OFF by default', () => {
  const twoJobs = () => [
    claim({ predicate: 'works_at', object: { entity: 'Nummo' } }),
    claim({ predicate: 'works_at', object: { entity: 'Zeta' }, claimId: 'c2' }),
  ];

  test('DOES NOT FIRE without a declared single-valued predicate', () => {
    // 🔴 The registry carries no cardinality flag — audited: its spec is
    // name/class/objectKind/inverse/symmetric/source. Firing on "different
    // object" without one is exactly FINDING-1's failure: a rule that accuses
    // the user of disagreeing with themselves for ordinary variation.
    const [a, b] = twoJobs();
    assert.equal(contradictionBetween(a, b).contradicts, false);
  });

  test('multi-valued predicates are never contradictions, declared or not', () => {
    const a = claim({ predicate: 'uses', object: { literal: 'Postgres' }, objectKind: 'literal' });
    const b = claim({ predicate: 'uses', object: { literal: 'Redis' }, objectKind: 'literal', claimId: 'c2' });
    assert.equal(contradictionBetween(a, b).contradicts, false);
    assert.equal(contradictionBetween(a, b, { functionalPredicates: new Set(['works_at']) }).contradicts, false);
  });

  test('FIRES when the caller declares the predicate single-valued', () => {
    // The branch exists and is tested; it is the SET that is empty, not the
    // logic that is missing.
    const [a, b] = twoJobs();
    const v = contradictionBetween(a, b, { functionalPredicates: new Set(['works_at']) });
    assert.equal(v.contradicts, true);
    assert.equal(v.kind, 'object');
  });

  test('a declared predicate still respects disjoint validity', () => {
    const a = claim({ object: { entity: 'Intercom' }, validFrom: '2020-01-01T00:00:00Z', validTo: '2024-01-01T00:00:00Z' });
    const b = claim({ object: { entity: 'Nummo' }, validFrom: '2025-01-01T00:00:00Z', claimId: 'c2' });
    assert.equal(contradictionBetween(a, b, { functionalPredicates: new Set(['works_at']) }).contradicts, false);
  });

  test('an array is accepted as well as a Set', () => {
    const [a, b] = twoJobs();
    assert.equal(contradictionBetween(a, b, { functionalPredicates: ['works_at'] }).contradicts, true);
  });
});

describe('S8 — it detects and REFUSES to decide', () => {
  test('BOTH contradicting claims survive', () => {
    // The load-bearing rule. Resolving here would leave one surviving row
    // looking like a fact nobody ever disputed, and Reflection would never
    // learn there had been a disagreement.
    const a = claim({ polarity: 'asserted', claimId: 'c1' });
    const b = claim({ polarity: 'negated', claimId: 'c2' });
    const r = dedupAndDetect([a, b]);

    assert.equal(r.contradictions.length, 1);
    assert.equal(r.claims.length, 2, 'neither claim was dropped');
    const polarities = r.claims.map(c => c.polarity).sort();
    assert.deepEqual(polarities, ['asserted', 'negated']);
  });

  test('the emitted record names both sides and the reason', () => {
    const r = dedupAndDetect([claim({ claimId: 'c1' }), claim({ polarity: 'negated', claimId: 'c2' })]);
    const [c] = r.contradictions;
    assert.equal(c.subject, 'self');
    assert.equal(c.predicate, 'works_at');
    assert.equal(c.incoming.claimId, 'c2');
    assert.equal(c.existing.claimId, 'c1');
    assert.match(c.reason, /asserted|negated/);
  });

  test('nothing in the result picks a winner', () => {
    const r = dedupAndDetect([claim(), claim({ polarity: 'negated', claimId: 'c2' })]);
    for (const k of ['resolved', 'winner', 'survivor', 'chosen']) {
      assert.equal(k in r, false, `S8 must not expose ${k} — resolution is Reflection's job`);
    }
  });
});

describe('S8 — incoming claims meet EXISTING history, not just each other', () => {
  test('a new claim contradicts one already stored', () => {
    const r = dedupAndDetect(
      [claim({ polarity: 'negated', claimId: 'new' })],
      [claim({ polarity: 'asserted', claimId: 'stored' })]);
    assert.equal(r.contradictions.length, 1);
    assert.equal(r.contradictions[0].existing.claimId, 'stored');
  });

  test('a repeat of a stored claim corroborates it', () => {
    const r = dedupAndDetect([claim({ claimId: 'new' })], [claim({ claimId: 'stored' })]);
    assert.equal(r.claims.length, 1);
    assert.equal(r.claims[0].corroborationCount, 2);
  });
});

describe('S8 — the semantic tier is inert until τ is measured', () => {
  test('it does not run when no merge function is supplied', () => {
    // It needs embeddings AND an LLM equivalence check, and τ has not been
    // measured. An unmeasured threshold applied by default is the thing this
    // project keeps refusing to ship.
    const r = dedupAndDetect([claim(), claim({ object: { entity: 'Nummo Inc' }, claimId: 'c2' })]);
    assert.equal(r.stats.semanticTierRan, false);
    assert.equal(r.claims.length, 2, 'near-duplicates stay separate without the tier');
  });

  test('stats distinguish "no merges" from "the tier never ran"', () => {
    // A merge rate of zero means something different in each case, and PR-11
    // has to be able to tell them apart.
    const withTier = dedupAndDetect([claim()], [], { semanticMerge: async () => false });
    assert.equal(withTier.stats.semanticTierRan, true);
  });
});

describe('S8 — degenerate input', () => {
  test('non-arrays yield nothing and do not throw', () => {
    for (const bad of [null, undefined, 'x', 42, {}]) {
      const r = dedupAndDetect(bad, bad);
      assert.equal(r.stats.incoming, 0);
      assert.deepEqual(r.claims, []);
    }
  });

  test('null entries are skipped', () => {
    const r = dedupAndDetect([null, claim(), undefined]);
    assert.equal(r.claims.length, 1);
  });

  test('contradictionBetween handles missing claims', () => {
    assert.equal(contradictionBetween(null, claim()).contradicts, false);
    assert.equal(contradictionBetween(claim(), undefined).contradicts, false);
  });

  test('different subject or predicate never contradicts', () => {
    assert.equal(contradictionBetween(claim({ subject: 'Dev' }), claim()).reason,
      'different-subject-predicate');
    assert.notEqual(subjectPredicateKey(claim({ predicate: 'knows' })), subjectPredicateKey(claim()));
  });
});
