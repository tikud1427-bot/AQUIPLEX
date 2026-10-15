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

// D6 (2026-10-05): "The backend is Rust now" — a REVISION of a many-valued
// relation that does not name the old value. Decided by the owner's history,
// never by guessing: exactly one other current value → it is what changed;
// two or more → ambiguous, nothing retired.
describe('sole-value revision (D6)', () => {
  const stored = (id, object, over = {}) => ({ claimId: id, subject: "Tidepool's backend", predicate: 'uses',
    object: { entity: object }, objectKind: 'entity', polarity: 'asserted', modality: 'fact', state: 'active', _persisted: true, ...over });
  const rust = (over = {}) => ({ claimId: 'rust', subject: "Tidepool's backend", predicate: 'uses',
    object: { entity: 'Rust' }, objectKind: 'entity', polarity: 'asserted', modality: 'fact', revises: true, ...over });

  test('one current value + a revision → a revision contradiction against it', () => {
    const r = dedupAndDetect([rust()], [stored('go', 'Go')]);
    assert.deepEqual(r.contradictions.map(c => [c.kind, c.existing.claimId]), [['revision', 'go']]);
    assert.deepEqual(r.ambiguousRevisions, []);
  });

  test('two current values → ambiguous: nothing is offered for retirement', () => {
    const r = dedupAndDetect([rust()], [stored('go', 'Go'), stored('pg', 'Postgres')]);
    assert.deepEqual(r.contradictions, []);
    assert.equal(r.ambiguousRevisions.length, 1);
    assert.equal(r.ambiguousRevisions[0].candidates, 2);
  });

  test('an ordinary (unmarked) statement never triggers it — "I use Postgres" + "I use Redis" stays compatible', () => {
    const r = dedupAndDetect([rust({ revises: undefined })], [stored('go', 'Go')]);
    assert.deepEqual(r.contradictions, []);
  });

  test('history and other subjects are not rivals', () => {
    const r = dedupAndDetect([rust()], [stored('old', 'Java', { state: 'superseded' }), stored('db', 'Go', { subject: 'database' }), stored('go', 'Go')]);
    assert.deepEqual(r.contradictions.map(c => c.existing.claimId), ['go']);
  });

  test('single-valued relations are left to the snapshot rule', () => {
    const r = dedupAndDetect(
      [{ claimId: 'porto', subject: 'You', predicate: 'located_in', object: { entity: 'Porto' }, objectKind: 'entity', polarity: 'asserted', modality: 'fact', revises: true }],
      [{ claimId: 'lisbon', subject: 'You', predicate: 'located_in', object: { entity: 'Lisbon' }, objectKind: 'entity', polarity: 'asserted', modality: 'fact', state: 'active', _persisted: true }],
      { functionalPredicates: new Set(['located_in']) });
    assert.deepEqual(r.contradictions.map(c => c.kind), ['object']);
  });

  test('a negated revision (the old value named) needs no inference', () => {
    const r = dedupAndDetect([rust({ polarity: 'negated', object: { entity: 'Go' } })], [stored('go', 'Go')]);
    assert.deepEqual(r.contradictions.map(c => c.kind), ['polarity']);
  });
});

// 2026-10-11: "My biggest client is now Sora Studio" (prompt rule 13) is about a
// DIFFERENT subject than the one it replaces. A role handed over is decided by
// the owner's history: exactly one other current holder → it is what changed.
describe('role handover (related_to, rule 13)', () => {
  const holder = (id, subject, role, over = {}) => ({ claimId: id, subject, predicate: 'related_to',
    object: { literal: role }, objectKind: 'literal', polarity: 'asserted', modality: 'fact', state: 'active', _persisted: true, ...over });
  const sora = (over = {}) => ({ claimId: 'sora', subject: 'Sora Studio', predicate: 'related_to',
    object: { literal: 'biggest client' }, objectKind: 'literal', polarity: 'asserted', modality: 'fact', revises: true, ...over });

  test('one other current holder + a revision → a revision contradiction against that holder', () => {
    const r = dedupAndDetect([sora()], [holder('kumo', 'Kumo Games', 'biggest client'), holder('ed', 'Daniel Brooks', 'editor')]);
    assert.deepEqual(r.contradictions.map(c => [c.kind, c.existing.claimId]), [['revision', 'kumo']]);
  });

  test('two current holders → ambiguous, nothing retired ("my client is now X" ends no other client)', () => {
    const r = dedupAndDetect([sora({ object: { literal: 'client' } })], [holder('a', 'Acme', 'client'), holder('b', 'Birch', 'client')]);
    assert.deepEqual(r.contradictions, []);
    assert.equal(r.ambiguousRevisions.length, 1);
  });

  test('an unmarked first statement never retires anyone; history and negations are not holders', () => {
    assert.deepEqual(dedupAndDetect([sora({ revises: undefined })], [holder('kumo', 'Kumo Games', 'biggest client')]).contradictions, []);
    const r = dedupAndDetect([sora()], [
      holder('old', 'Old Co', 'biggest client', { state: 'superseded' }),
      holder('neg', 'Neg Co', 'biggest client', { polarity: 'negated' }),
    ]);
    assert.deepEqual(r.contradictions, []);
  });

  test('the named old holder (negated, revises) is a plain polarity flip', () => {
    const r = dedupAndDetect([sora({ claimId: 'db-neg', subject: 'Daniel Brooks', object: { literal: 'editor' }, polarity: 'negated' })],
      [holder('ed', 'Daniel Brooks', 'editor')]);
    assert.deepEqual(r.contradictions.map(c => c.kind), ['polarity']);
  });
});

// Pass 2 (2026-10-11): an explicit RESOLUTION status retires only the blocker
// claims LINKED to the resolved thing; a generic positive update retires nothing.
describe('blocker resolution (Pass 2)', () => {
  const stored = (id, subject, predicate, object, over = {}) => ({ claimId: id, subject, predicate, object,
    objectKind: object.entity ? 'entity' : 'literal', polarity: 'asserted', modality: 'fact', state: 'active', _persisted: true, ...over });
  const status = (subject, literal, over = {}) => ({ claimId: 'new', subject, predicate: 'has_status', object: { literal }, objectKind: 'literal',
    polarity: 'asserted', modality: 'fact', ...over });
  const history = () => [
    stored('b1', 'visa application', 'blocked_by', { entity: 'the embassy' }),
    stored('b2', 'the embassy', 'has_property', { literal: "hasn't returned my passport" }),
    stored('b3', 'antenna supplier', 'blocks', { entity: 'drone project' }),
    stored('b4', 'the embassy', 'has_property', { literal: 'is in the city centre' }),
  ];

  test('"the embassy returned my passport" retires the blocker relation and the embassy\'s pending state — only those', () => {
    const r = dedupAndDetect([status('The Embassy', 'returned my passport')], history());
    assert.deepEqual(r.contradictions.map(c => c.existing.claimId).sort(), ['b1', 'b2']);
    assert.ok(r.contradictions.every(c => c.kind === 'revision'));
    assert.equal(r.claims.find(c => c.claimId === 'new').revises, true, 'marked as a revision so rule 2 retires the older claims');
  });

  test('resolving the blocked TASK itself retires its blockers', () => {
    const r = dedupAndDetect([status('the drone project', 'completed')], history());
    assert.deepEqual(r.contradictions.map(c => c.existing.claimId), ['b3']);
  });

  test('a positive update that is not a resolution, or a still-pending status, retires nothing', () => {
    for (const lit of ['going well', 'still not signed', "hasn't arrived yet", 'waiting to be approved']) {
      const r = dedupAndDetect([status('the embassy', lit)], history());
      assert.deepEqual(r.contradictions.filter(c => c.kind === 'revision'), [], lit);
    }
  });

  test('an unrelated thing being resolved does not touch other blockers', () => {
    const r = dedupAndDetect([status('the printer', 'fixed')], history());
    assert.deepEqual(r.contradictions, []);
  });
});

// Pass 2 (2026-10-11): a renamed mention of the same event, linked conservatively.
describe('renamed subject revision (Pass 2)', () => {
  const FUNC = { functionalPredicates: new Set(['deadline_for']) };
  const old = (id, subject, date, statementText, over = {}) => ({ claimId: id, subject, predicate: 'deadline_for', object: { literal: date },
    objectKind: 'literal', polarity: 'asserted', modality: 'fact', state: 'active', _persisted: true, statementText, ...over });
  const moved = (subject, over = {}) => ({ claimId: 'new', subject, predicate: 'deadline_for', object: { literal: 'May 18' }, objectKind: 'literal',
    polarity: 'asserted', modality: 'fact', revises: true, statementText: `Actually the ${subject} moved to May 18`, ...over });

  test('"the planter launch moved" retires the date stated as "launching the ceramic planter line" — even under a mis-attributed subject', () => {
    const r = dedupAndDetect([moved('planter launch')], [old('p', 'You', 'May 4', "We're launching the ceramic planter line on May 4")], FUNC);
    assert.deepEqual(r.contradictions.map(c => [c.kind, c.existing.claimId]), [['revision', 'p']]);
  });

  test('a generic mention ("the launch moved") links nothing — any launch could be meant', () => {
    const r = dedupAndDetect([moved('launch')], [old('p', 'planter line', 'May 4', 'The planter line launches on May 4')], FUNC);
    assert.deepEqual(r.contradictions, []);
  });

  test('two candidates (same-name things in two projects) → ambiguous, nothing retired', () => {
    const r = dedupAndDetect([moved('planter launch')], [
      old('a', 'ceramic planter launch', 'May 4', 'The ceramic planter launch is May 4'),
      old('b', 'concrete planter launch', 'June 2', 'The concrete planter launch is June 2'),
    ], FUNC);
    assert.deepEqual(r.contradictions, []);
    assert.equal(r.ambiguousRevisions.at(-1).reason, 'renamed-subject');
  });

  test('a different distinctive word does not link ("website launch" vs "planter launch"); no revision marker → no link', () => {
    const hist = [old('p', 'planter launch', 'May 4', 'The planter launch is May 4')];
    assert.deepEqual(dedupAndDetect([moved('website launch')], hist, FUNC).contradictions, []);
    assert.deepEqual(dedupAndDetect([moved('planter line', { revises: undefined })], hist, FUNC).contradictions, []);
  });

  test('when the new subject already holds its own value, the ordinary snapshot rule decides — no rename inference', () => {
    const r = dedupAndDetect([moved('planter launch')], [old('own', 'planter launch', 'May 9', 'The planter launch is May 9'),
      old('p', 'You', 'May 4', "We're launching the ceramic planter line on May 4")], FUNC);
    assert.deepEqual(r.contradictions.map(c => c.existing.claimId), ['own']);
  });
});
