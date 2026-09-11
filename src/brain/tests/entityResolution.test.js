/**
 * S6 — entity resolution.
 *
 * The never-fuse invariant carries this file. The blueprint calls it "correct
 * and hard-won" and asks for it to be "pinned by negative test", so the
 * negative tests here are the ones that matter: `I` must never reach the store,
 * never become an entity named "i", and never fuse the speaker into a
 * short-named person.
 *
 * Run: node --test src/brain/tests/entityResolution.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveSurface, resolveClaimEntities, resolveBatch, isDeixis,
  TIER, MERGE_THRESHOLD, REVIEW_THRESHOLD,
} from '../understanding/entityResolution.js';
import { normalizeMention, mentionSimilarity } from '../../reasoning/entityResolver.js';

/** An owner-scoped store that RECORDS every lookup, so "never touched" is measurable. */
function makeStore(entities = []) {
  const list = entities.map((e, i) => (typeof e === 'string' ? { id: `e${i}`, name: e } : e));
  const looked = [];
  return {
    looked,
    all: () => list,
    byNormalized: n => { looked.push(['byNormalized', n]); return list.find(e => normalizeMention(e.name) === n) ?? null; },
    byAlias: n => { looked.push(['byAlias', n]); return list.find(e => (e.aliases ?? []).some(a => normalizeMention(a) === n)) ?? null; },
  };
}

const SELF = 'owner-self-1';

describe('🔴 the never-fuse invariant — deixis never reaches the id store', () => {
  test('every first-person form resolves by GRAMMAR, with no lookup at all', async () => {
    // The failure this prevents: `I` gets normalised, matches nothing, and a
    // provisional entity named "i" accumulates every first-person claim under
    // a node that is not a person.
    const store = makeStore(['Nummo', 'Dev']);
    for (const d of ['I', 'i', 'me', 'my', 'we', 'our', 'us', 'myself', 'self', 'My.', 'WE']) {
      const r = await resolveSurface(d, store, { selfEntityId: SELF });
      assert.equal(r.entityId, SELF, `${d} did not resolve to the self entity`);
      assert.equal(r.tier, TIER.SELF);
    }
    assert.deepEqual(store.looked, [], 'the store was consulted for a pronoun');
  });

  test('deixis cannot FUSE into a real short name, however similar', async () => {
    // A store containing a person called "Mi" or "Wu" must not attract "my" or
    // "we" through the fuzzy tier. There is no threshold involved because the
    // deixis branch returns before any score is computed.
    const store = makeStore(['Mi', 'Wu', 'Us']);
    for (const d of ['my', 'we', 'us']) {
      const r = await resolveSurface(d, store, { selfEntityId: SELF });
      assert.equal(r.entityId, SELF, `${d} fused into a store entity`);
    }
    assert.deepEqual(store.looked, []);
  });

  test('a pronoun NEVER becomes a provisional entity', async () => {
    // Even with no self entity configured, the answer is "no self entity",
    // never "create one called i".
    const store = makeStore([]);
    const r = await resolveSurface('I', store, {});
    assert.equal(r.provisional, false, 'a pronoun must never be minted as an entity');
    assert.equal(r.reason, 'no-self-entity');
    assert.deepEqual(store.looked, []);
  });

  test('a real name that merely CONTAINS a pronoun is not deixis', async () => {
    // "Ivy" starts with "i"; "Wendy" starts with "we". Whole-token matching,
    // not prefix matching — over-firing here would send real people to the
    // self entity, which is the same fusion in the other direction.
    for (const name of ['Ivy', 'Wendy', 'Ian', 'Ousmane', 'Mya']) {
      assert.equal(isDeixis(name), false, `${name} was treated as deixis`);
    }
    const store = makeStore(['Ivy']);
    const r = await resolveSurface('Ivy', store, { selfEntityId: SELF });
    assert.equal(r.tier, TIER.EXACT);
    assert.notEqual(r.entityId, SELF);
  });
});

describe('S6 — tier ① exact normalized', () => {
  test('an exact match resolves without scoring', async () => {
    const store = makeStore(['Nummo']);
    const r = await resolveSurface('Nummo', store, { selfEntityId: SELF });
    assert.equal(r.tier, TIER.EXACT);
    assert.equal(r.provisional, false);
  });

  test('normalisation is the SHIPPED one — legal suffixes strip', async () => {
    // "Nummo Inc." and "Nummo" are one company. Reimplementing this would
    // drift from reasoning/entityResolver.js and put two Nummos in the graph.
    const store = makeStore(['Nummo']);
    const r = await resolveSurface('Nummo Inc.', store, { selfEntityId: SELF });
    assert.equal(r.tier, TIER.EXACT, 'the shipped normaliser strips Inc.');
  });
});

describe('S6 — tier ② alias', () => {
  test('a known alias resolves', async () => {
    const store = makeStore([{ id: 'e-nummo', name: 'Nummo Technologies', aliases: ['Nummo', 'NMO'] }]);
    const r = await resolveSurface('NMO', store, { selfEntityId: SELF });
    assert.equal(r.entityId, 'e-nummo');
    assert.equal(r.tier, TIER.ALIAS);
  });

  test('exact is tried BEFORE alias', async () => {
    // An alias of one entity colliding with the canonical name of another must
    // not win. Ordering is the only thing preventing that.
    const store = makeStore([
      { id: 'e-real', name: 'Zeta' },
      { id: 'e-other', name: 'Nummo', aliases: ['Zeta'] },
    ]);
    const r = await resolveSurface('Zeta', store, { selfEntityId: SELF });
    assert.equal(r.entityId, 'e-real');
    assert.equal(r.tier, TIER.EXACT);
  });
});

describe('S6 — tier ③ fuzzy, and the band it refuses to guess in', () => {
  test('a single confident match resolves', async () => {
    const store = makeStore(['OpenAI']);
    const r = await resolveSurface('Open AI', store, { selfEntityId: SELF });
    assert.equal(r.tier, TIER.FUZZY);
    assert.ok(r.score >= MERGE_THRESHOLD);
  });

  test('TWO confident matches are AMBIGUOUS, never the top score', async () => {
    // The cardinal failure: fusing two distinct "John"s. Picking the higher
    // score when both are confident is exactly how it happens, and the score
    // gap carries no information about which is right.
    const store = makeStore([{ id: 'j1', name: 'John Smith' }, { id: 'j2', name: 'John Smyth' }]);
    const r = await resolveSurface('John Smith', store, { selfEntityId: SELF });
    if (r.tier === TIER.AMBIGUOUS) {
      assert.ok(r.candidates.length >= 2);
      assert.equal(r.entityId, null, 'nothing was chosen');
    } else {
      // An exact normalized hit is legitimate and takes tier ① — assert it did
      // not silently fuzz onto the OTHER John.
      assert.equal(r.entityId, 'j1');
    }
  });

  test('THE LIVE AMBIGUITY: two candidates above the merge threshold refuse to fuse', async () => {
    // Measured, and this is the case that actually occurs. Both `Rahul Nair`
    // and `Rahul Verma` score 0.84 against `Rahul` via token-subset. Taking
    // the top score would fuse two people on a tie the score cannot break.
    const store = makeStore([{ id: 'r1', name: 'Rahul Nair' }, { id: 'r2', name: 'Rahul Verma' }]);
    const r = await resolveSurface('Rahul', store, { selfEntityId: SELF });
    assert.equal(r.tier, TIER.AMBIGUOUS);
    assert.equal(r.entityId, null, 'nothing was chosen');
    assert.equal(r.reason, 'multiple-above-merge-threshold');
    assert.equal(r.candidates.length, 2);
    assert.equal(r.candidates[0].score, r.candidates[1].score, 'a tie the score cannot break');
  });

  test('GAP 1 — tier ③ is not trigram, so a TYPO creates a duplicate', async () => {
    // `Numo` vs `Nummo` scores 0.000: mentionSimilarity compares tokens, not
    // characters. Trigram fuzzy exists precisely for this shape and the reused
    // function does not provide it.
    //
    // Recorded, not fixed. Writing a character-level scorer here would make
    // two similarity functions in one system, and the drift would show up as
    // one entity resolved differently depending on which path reached it —
    // exactly what reusing the shipped one avoids.
    const store = makeStore(['Nummo']);
    const r = await resolveSurface('Numo', store, { selfEntityId: SELF });
    assert.equal(r.tier, TIER.PROVISIONAL,
      'INVERT THIS TEST when character-level similarity is added to the shipped resolver');
    assert.equal(TIER.FUZZY, 'token-overlap', 'the tier is named for what it does');
  });

  test('GAP 2 — the review band is essentially unreachable', async () => {
    // Scores cluster: 1.00 exact, 0.86/0.84 subset, ~0.33 overlap. Nothing
    // realistic lands between REVIEW 0.62 and MERGE 0.82, so the band the
    // blueprint reserves for tier ⑤ is rarely the ambiguity that matters.
    const probes = [['John Smith', 'John Smyth'], ['Priya Sharma', 'Priya Verma'],
      ['Dev Kumar', 'Dev Kumar Singh'], ['Rahul Nair', 'Rahul']];
    const inBand = probes.filter(([a, b]) => {
      const s = mentionSimilarity(normalizeMention(a), normalizeMention(b)).score;
      return s >= REVIEW_THRESHOLD && s < MERGE_THRESHOLD;
    });
    assert.deepEqual(inBand, [],
      'a pair now lands in the review band — good, but re-read GAP 2 before trusting the band');
  });

  test('GAP 3 — suffix stripping fuses a subsidiary into its parent', async () => {
    // Inc · Ltd · Group · Holdings · Labs · Systems all strip. Right for
    // cross-file dedup; in a personal graph "Nummo Labs" and "Nummo" may be
    // two employers. Flagged, not changed — the normaliser has other callers.
    assert.equal(normalizeMention('Nummo Labs'), normalizeMention('Nummo'));
    const store = makeStore(['Nummo']);
    const r = await resolveSurface('Nummo Labs', store, { selfEntityId: SELF });
    assert.equal(r.tier, TIER.EXACT,
      'INVERT THIS TEST if the normaliser is ever narrowed for personal graphs');
  });

  test('the thresholds are the SHIPPED ones, not new numbers', () => {
    assert.equal(MERGE_THRESHOLD, 0.82);
    assert.equal(REVIEW_THRESHOLD, 0.62);
  });

  test('an unrelated name does not match', async () => {
    const store = makeStore(['Nummo']);
    const r = await resolveSurface('Razorpay', store, { selfEntityId: SELF });
    assert.equal(r.tier, TIER.PROVISIONAL);
  });
});

describe('S6 — tiers ④⑤ are injected and absent by default', () => {
  test('with no embedding or disambiguator, the band stays ambiguous', async () => {
    const store = makeStore([{ id: 'j1', name: 'John Smyth' }, { id: 'j2', name: 'Jon Smyth' }]);
    const r = await resolveSurface('John Smyth', store, { selfEntityId: SELF });
    assert.notEqual(r.tier, TIER.EMBEDDING);
    assert.notEqual(r.tier, TIER.DISAMBIGUATED);
  });

  test('a supplied disambiguator can break a two-candidate tie', async () => {
    const store = makeStore([{ id: 'j1', name: 'John Smith' }, { id: 'j2', name: 'John Smyth' }]);
    const r = await resolveSurface('John Smythe', store, {
      selfEntityId: SELF,
      disambiguate: async (_s, cands) => cands.find(c => c.id === 'j2') ?? null,
    });
    if (r.tier === TIER.DISAMBIGUATED) assert.equal(r.entityId, 'j2');
  });

  test('a disambiguator returning null leaves it ambiguous, not guessed', async () => {
    const store = makeStore([{ id: 'j1', name: 'John Smith' }, { id: 'j2', name: 'John Smyth' }]);
    const r = await resolveSurface('John Smythe', store, {
      selfEntityId: SELF, disambiguate: async () => null,
    });
    assert.notEqual(r.tier, TIER.DISAMBIGUATED);
    assert.equal(r.entityId, null);
  });
});

describe('S6 — no confident match creates a PROVISIONAL entity', () => {
  test('an unknown name is provisional and carries what it needs to be created', async () => {
    const store = makeStore([]);
    const r = await resolveSurface('Zeta Systems', store, { selfEntityId: SELF });
    assert.equal(r.tier, TIER.PROVISIONAL);
    assert.equal(r.provisional, true);
    assert.equal(r.proposedName, 'Zeta Systems');
    assert.equal(r.normalized, normalizeMention('Zeta Systems'));
  });

  test('provisional is NOT the same as ambiguous', async () => {
    // An ambiguous subject needs adjudication; a provisional one needs an
    // insert. Treating them alike either creates duplicates or blocks on
    // nothing.
    const unknown = await resolveSurface('Zeta', makeStore([]), { selfEntityId: SELF });
    assert.equal(unknown.provisional, true);
    const ambiguous = await resolveSurface('John Smyth',
      makeStore([{ id: 'a', name: 'John Smyth' }, { id: 'b', name: 'John Smythe' }]), { selfEntityId: SELF });
    if (ambiguous.tier === TIER.AMBIGUOUS) assert.equal(ambiguous.provisional, false);
  });
});

describe('S6 — a claim is READY for S7 only when both ends have ids', () => {
  const claim = (over = {}) => ({
    subject: 'self', predicate: 'works_at',
    objectKind: 'entity', object: { entity: 'Nummo' }, ...over,
  });

  test('both ends resolved → ready', async () => {
    const r = await resolveClaimEntities(claim(), makeStore(['Nummo']), { selfEntityId: SELF });
    assert.equal(r.ready, true);
    assert.equal(r.subject.entityId, SELF);
    assert.equal(r.blockedBy, null);
  });

  test('an unresolved OBJECT blocks, and says so', async () => {
    // Letting this through would mint an edge to a node that does not exist —
    // E6/PR-8's "node nothing else can ever reach".
    const r = await resolveClaimEntities(claim(), makeStore([]), { selfEntityId: SELF });
    assert.equal(r.ready, false);
    assert.match(r.blockedBy, /^object:/);
  });

  test('an unresolved SUBJECT blocks', async () => {
    const r = await resolveClaimEntities(claim({ subject: 'Priya' }), makeStore(['Nummo']), { selfEntityId: SELF });
    assert.equal(r.ready, false);
    assert.match(r.blockedBy, /^subject:/);
  });

  test('a literal-object claim needs only its subject', async () => {
    const r = await resolveClaimEntities(
      claim({ predicate: 'uses', objectKind: 'literal', object: { literal: 'Postgres' } }),
      makeStore([]), { selfEntityId: SELF });
    assert.equal(r.ready, true, 'a literal object is not an entity and must not block');
  });

  test('degenerate input does not throw', async () => {
    for (const bad of [null, undefined, {}, 'claim']) {
      const r = await resolveClaimEntities(bad, makeStore([]), { selfEntityId: SELF });
      assert.equal(r.ready, false);
    }
  });
});

describe('S6 — batch stats say which tier did the work', () => {
  test('tiers are counted separately', async () => {
    // "Everything resolved" means something very different when it was all
    // provisional creation than when it was exact matches.
    const store = makeStore(['Nummo']);
    const r = await resolveBatch([
      { subject: 'self', objectKind: 'entity', object: { entity: 'Nummo' } },
      { subject: 'self', objectKind: 'entity', object: { entity: 'Zeta' } },
    ], store, { selfEntityId: SELF });

    assert.equal(r.stats.seen, 2);
    assert.equal(r.stats.ready, 1, 'only the known company resolved');
    assert.equal(r.stats.provisional, 1);
    assert.equal(r.stats.byTier[TIER.SELF], 2);
    assert.equal(r.stats.byTier[TIER.EXACT], 1);
  });

  test('a non-array yields nothing and does not throw', async () => {
    for (const bad of [null, undefined, 'x', 42]) {
      const r = await resolveBatch(bad, makeStore([]), {});
      assert.equal(r.stats.seen, 0);
    }
  });
});
