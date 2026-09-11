/**
 * E6/PR-8 — relationship resolution (S7).
 *
 * The claim worth most here is the one that is easiest to get wrong and
 * hardest to notice: "I work at Nummo" and "Nummo employs me" are ONE edge.
 * Store them as two and a k-hop walk sees a cycle that does not exist, dedup
 * never fires, and the relationship's evidence is split so neither row looks
 * well-supported.
 *
 * Run: node --test src/brain/tests/relationshipResolver.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  edgeFromClaim, resolveRelationships, canonicalDirection, chooseCanonical, edgeKey, MAX_EDGE_HISTORY,
} from '../understanding/relationshipResolver.js';
import { allPredicates, getPredicate } from '../../core/claims/predicateRegistry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const claim = (over = {}) => ({
  subject: 'self',
  predicate: 'works_at',
  object: { entity: 'Nummo' },
  polarity: 'asserted',
  modality: 'fact',
  claimId: 'c1',
  confidence: { extraction: 0.6 },
  ...over,
});

describe('S7 — direction comes from the predicate, not word order', () => {
  test('THE CENTRAL CASE: works_at and employs are ONE edge', () => {
    const a = edgeFromClaim(claim({ subject: 'self', predicate: 'works_at', object: { entity: 'Nummo' } }));
    const b = edgeFromClaim(claim({ subject: 'Nummo', predicate: 'employs', object: { entity: 'self' }, claimId: 'c2' }));

    assert.ok(a.ok && b.ok, `${a.reason ?? ''} ${b.reason ?? ''}`);
    assert.equal(edgeKey(a.edge), edgeKey(b.edge),
      'the same relationship stated two ways must produce the same edge key');
    assert.equal(a.edge.type, b.edge.type);
    assert.equal(a.edge.from, b.edge.from);
    assert.equal(a.edge.to, b.edge.to);
  });

  test('the flip is RECORDED, so canonicalisation is not mistaken for an extractor bug', () => {
    const b = edgeFromClaim(claim({ subject: 'Nummo', predicate: 'employs', object: { entity: 'self' } }));
    assert.equal(b.edge.assertedAs, 'employs', 'the claim said employs');
    assert.equal(b.edge.type, 'employs' <= 'works_at' ? 'employs' : 'works_at');
    assert.equal(b.edge.flipped, b.edge.type !== 'employs');
  });

  test('reports_to and manages collapse to one edge', () => {
    const a = edgeFromClaim(claim({ subject: 'self', predicate: 'reports_to', object: { entity: 'Priya' } }));
    const b = edgeFromClaim(claim({ subject: 'Priya', predicate: 'manages', object: { entity: 'self' }, claimId: 'c2' }));
    assert.equal(edgeKey(a.edge), edgeKey(b.edge));
  });

  test('member_of and has_member collapse to one edge', () => {
    const a = edgeFromClaim(claim({ subject: 'self', predicate: 'member_of', object: { entity: 'Platform' } }));
    const b = edgeFromClaim(claim({ subject: 'Platform', predicate: 'has_member', object: { entity: 'self' }, claimId: 'c2' }));
    assert.equal(edgeKey(a.edge), edgeKey(b.edge));
  });

  test('the canonical choice is STABLE — instability means duplicate edges over time', () => {
    // The choice between works_at and employs is arbitrary; that it never
    // changes is not. Lexicographic order is used because it cannot drift when
    // someone edits a predicate's description.
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(canonicalDirection('employs'), canonicalDirection('employs'));
      assert.deepEqual(canonicalDirection('works_at'), canonicalDirection('works_at'));
    }
    assert.equal(canonicalDirection('works_at').type, canonicalDirection('employs').type,
      'both members of a pair resolve to the same type');
  });

  test('a predicate with no inverse keeps subject → object', () => {
    assert.deepEqual(canonicalDirection('located_in'), { type: 'located_in', flip: false });
    const e = edgeFromClaim(claim({ subject: 'Nummo', predicate: 'located_in', object: { entity: 'Bangalore' } }));
    assert.equal(e.edge.from, 'Nummo');
    assert.equal(e.edge.to, 'Bangalore');
  });
});

describe('S7 — symmetric predicates canonicalise the ENDPOINTS', () => {
  test('A knows B and B knows A are one edge', () => {
    // Without sorting, mutual acquaintance produces two rows and the graph
    // reports twice the connections it has.
    const a = edgeFromClaim(claim({ subject: 'Ananya', predicate: 'knows', object: { entity: 'Dev' } }));
    const b = edgeFromClaim(claim({ subject: 'Dev', predicate: 'knows', object: { entity: 'Ananya' }, claimId: 'c2' }));
    assert.equal(edgeKey(a.edge), edgeKey(b.edge));
    assert.deepEqual([a.edge.from, a.edge.to], ['Ananya', 'Dev'], 'endpoints sorted');
  });

  test('a symmetric predicate is never type-flipped', () => {
    // `knows` is its own inverse. Flipping the type as well as sorting the
    // endpoints would undo the sort.
    assert.deepEqual(canonicalDirection('knows'), { type: 'knows', flip: false });
  });
});

describe('S7 — the registry defect is FIXED, and the guard outlived it', () => {
  test('owns now holds an entity, as its own inverse always implied', () => {
    // ✅ INVERTED, ON THE INSTRUCTION THIS TEST LEFT BEHIND.
    //
    // It used to read `assert.equal(getPredicate('owns').objectKind, 'literal',
    // 'the defect still exists')` and ended with "INVERT THIS TEST if owns is
    // ever corrected to entity-object". It has been.
    //
    // The correction is derived, not chosen: "A owns B" is "B owned_by A", so
    // `owns`'s object is `owned_by`'s subject, and subjects are entities.
    // `owned_by` was already `entity` two lines below it in the registry. Four
    // more pairs were wrong the same way. `predicateRegistry.test.js` now
    // enforces the rule so a sixth cannot be added by hand.
    //
    // What made it worth doing: every contract rejection across a 525-call eval
    // run was `object-kind-mismatch`, on objects like `owns → billing service`
    // and `blocks → Priya`. A person, refused for not being a literal.
    assert.equal(getPredicate('owns').objectKind, 'entity', 'the correction was reverted');
    assert.equal(getPredicate('owned_by').objectKind, 'entity');

    // Same answer as before, for a DIFFERENT reason — worth stating, because a
    // green test here no longer means the guard is doing anything. Before, the
    // guard forced the entity side; now `'owned_by' < 'owns'` picks it and the
    // guard has nothing to correct.
    assert.deepEqual(canonicalDirection('owned_by'), { type: 'owned_by', flip: false });
  });

  test('the guard fires on a pair where alphabetical order would get it WRONG', () => {
    // Measured: deleting the guard failed ZERO tests, because for the one
    // broken pair `'owned_by' < 'owns'` already picks the entity-side member.
    // Since the registry correction there is no broken pair left at all, so
    // this synthetic case is now the ONLY thing exercising the guard — keep it.
    // The guard was resting on an accident of alphabetical order, and a rename
    // would have removed the protection silently.
    //
    // Synthetic specs, so the invariant is tested rather than the coincidence.
    const literalSide = { name: 'aaa_owns', inverse: 'zzz_owned_by', objectKind: 'literal', symmetric: false };
    const entitySide  = { name: 'zzz_owned_by', inverse: 'aaa_owns', objectKind: 'entity', symmetric: false };

    // Without the guard, lexicographic order would canonicalise the entity
    // claim onto `aaa_owns` — a type that cannot legally hold an entity
    // object, so S4 gate ② would reject the very claim this edge came from.
    assert.deepEqual(chooseCanonical(entitySide, literalSide),
      { type: 'zzz_owned_by', flip: false },
      'canonicalisation must not pick a literal-object predicate as an edge type');

    // And the guard does not over-fire: a well-formed pair still canonicalises.
    const a = { name: 'zzz_b_side', inverse: 'aaa_a_side', objectKind: 'entity', symmetric: false };
    const b = { name: 'aaa_a_side', inverse: 'zzz_b_side', objectKind: 'entity', symmetric: false };
    assert.deepEqual(chooseCanonical(a, b), { type: 'aaa_a_side', flip: true });
    assert.deepEqual(chooseCanonical(b, a), { type: 'aaa_a_side', flip: false });
  });

  test('every OTHER inverse pair is reciprocal and kind-consistent', () => {
    // Audited once; pinned so a future registry edit cannot quietly add a
    // second offender that canonicalisation would then mishandle.
    const offenders = [];
    for (const p of allPredicates()) {
      if (!p.inverse) continue;
      const inv = getPredicate(p.inverse);
      if (!inv) { offenders.push(`${p.name}: inverse ${p.inverse} not registered`); continue; }
      if (inv.inverse !== p.name) offenders.push(`${p.name} ↔ ${p.inverse} not reciprocal`);
      if (inv.objectKind !== p.objectKind) offenders.push(`${p.name}(${p.objectKind}) ↔ ${p.inverse}(${inv.objectKind})`);
    }
    // WAS a two-entry allow-list naming the owns ↔ owned_by mismatch. The
    // registry correction emptied it.
    //
    // ⚠️ AND THIS TEST COULD NEVER HAVE FOUND THE OTHER FOUR. It compares the
    // two halves of a pair to EACH OTHER, and `depends_on` ↔ `depended_on_by`
    // and `blocks` ↔ `blocked_by` were both literal — consistent, and
    // consistently wrong. Agreement is not correctness. The rule that catches
    // them is in `predicateRegistry.test.js`: an inverse makes the object a
    // subject on the other side, and subjects are entities.
    assert.deepEqual(offenders.sort(), [],
      'a new inverse-pair inconsistency appeared — canonicalisation assumes there are none');
  });
});

describe('S7 — only entity-object FACTS become edges', () => {
  const rejects = (over, reason) => {
    const r = edgeFromClaim(claim(over));
    assert.equal(r.ok, false, `${JSON.stringify(over)} should be rejected`);
    assert.match(r.reason, new RegExp(reason));
  };

  test('a literal-object claim stays out of the graph', () => {
    // `prefers → "Postgres"` is a real claim about a literal. An edge to a
    // string that was never resolved to an entity is a node nothing can reach.
    rejects({ predicate: 'prefers', object: { literal: 'Postgres' } }, 'not-an-entity-object');
  });

  test('a NEGATED claim asserts the edge does NOT exist', () => {
    // Writing it and hoping a reader checks polarity is how "Priya no longer
    // works at Aquiplex" becomes "Priya works at Aquiplex" two hops later.
    rejects({ polarity: 'negated' }, 'negated-claim');
  });

  test('intent and hypothetical do not materialise', () => {
    // "I plan to join Zeta" describes a world that is not this one.
    for (const m of ['intent', 'hypothetical', 'question', 'quote']) {
      rejects({ modality: m }, 'non-factual-modality');
    }
  });

  test('a claim with no claimId is refused — the edge table is DERIVED', () => {
    // "claim_id is the truth." An edge without one is unrebuildable and
    // unauditable, so a null is worse than no row.
    const r = edgeFromClaim({ ...claim(), claimId: null });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-claim-id');
  });

  test('a self-loop is refused', () => {
    // Almost always a resolution bug upstream, and it makes every traversal
    // non-terminating without a visited set.
    rejects({ subject: 'Nummo', object: { entity: 'Nummo' } }, 'self-loop');
  });

  test('unregistered predicates and missing endpoints are refused', () => {
    rejects({ predicate: 'enjoys_working_at' }, 'unregistered-predicate');
    rejects({ object: {} }, 'missing-endpoint');
    rejects({ subject: null }, 'missing-endpoint');
  });

  test('degenerate input does not throw', () => {
    for (const bad of [null, undefined, 'claim', 42, []]) {
      assert.equal(edgeFromClaim(bad).ok, false);
    }
  });
});

describe('S7 — edges are temporal and evidence-bound', () => {
  test('the validity window comes through from S5', () => {
    const r = edgeFromClaim(claim({ validFrom: '2024-01-01T00:00:00.000Z', validTo: null }));
    assert.equal(r.edge.validFrom, '2024-01-01T00:00:00.000Z');
    assert.equal(r.edge.validTo, null, 'an open range stays open');
  });

  test('the edge names the claim that asserts it', () => {
    assert.equal(edgeFromClaim(claim({ claimId: 'c-42' })).edge.claimId, 'c-42');
  });

  test('confidence is carried, not recomputed', () => {
    assert.equal(edgeFromClaim(claim({ confidence: { extraction: 0.45 } })).edge.confidence, 0.45);
  });
});

describe('S7 — upsert, not append', () => {
  test('the same relationship asserted twice is ONE edge with corroboration', () => {
    const r = resolveRelationships([
      claim({ claimId: 'c1', confidence: { extraction: 0.6 } }),
      claim({ subject: 'Nummo', predicate: 'employs', object: { entity: 'self' }, claimId: 'c2', confidence: { extraction: 0.9 } }),
    ], { now: 1000 });

    assert.equal(r.edges.length, 1, 'two statements of one fact are one edge');
    assert.equal(r.edges[0].confidence, 0.9, 'the stronger evidence wins');
    assert.equal(r.edges[0].history.length, 1, 'and the change is auditable');
  });

  test('history is BOUNDED at the same limit reasoningGraph uses', () => {
    // Two different bounds on one ring buffer is the same defect class as two
    // different length floors. reasoningGraph.js does not export its constant,
    // so the agreement is asserted by reading the file.
    const src = readFileSync(path.join(HERE, '..', '..', 'reasoning', 'reasoningGraph.js'), 'utf8');
    const m = src.match(/const MAX_EDGE_HISTORY = (\d+);/);
    assert.ok(m, 'reasoningGraph no longer declares MAX_EDGE_HISTORY — re-check this');
    assert.equal(Number(m[1]), MAX_EDGE_HISTORY, 'the two bounds disagree');
  });

  test('the ring actually caps', () => {
    const many = Array.from({ length: MAX_EDGE_HISTORY + 10 }, (_, i) =>
      claim({ claimId: `c${i}`, confidence: { extraction: 0.5 + i / 1000 } }));
    const r = resolveRelationships(many, { now: 1 });
    assert.equal(r.edges.length, 1);
    assert.equal(r.edges[0].history.length, MAX_EDGE_HISTORY);
  });

  test('firstSeenAt keeps the EARLIEST, lastSeenAt advances', () => {
    const a = resolveRelationships([claim({ claimId: 'c1' })], { now: 100 });
    const merged = resolveRelationships([
      { ...claim({ claimId: 'c1' }) }, { ...claim({ claimId: 'c2' }) },
    ], { now: 500 });
    assert.equal(a.edges[0].firstSeenAt, 100);
    assert.equal(merged.edges[0].firstSeenAt, 500);
    assert.equal(merged.edges[0].lastSeenAt, 500);
  });

  test('different relationships stay separate', () => {
    const r = resolveRelationships([
      claim({ predicate: 'works_at', object: { entity: 'Nummo' }, claimId: 'c1' }),
      claim({ predicate: 'located_in', subject: 'Nummo', object: { entity: 'Bangalore' }, claimId: 'c2' }),
      claim({ predicate: 'knows', subject: 'Ananya', object: { entity: 'Dev' }, claimId: 'c3' }),
    ]);
    assert.equal(r.edges.length, 3);
  });
});

describe('S7 — the proposal queue counts usage', () => {
  test('an unknown predicate is queued with a count, not silently dropped', () => {
    // One sighting of `enjoys_working_at` is noise; forty is a vocabulary that
    // is too small. Only a counter distinguishes them, and without it the
    // queue is a list of every typo a model ever made.
    const r = resolveRelationships([
      claim({ predicate: 'enjoys_working_at', statementText: 'I love working at Nummo' }),
      claim({ predicate: 'enjoys_working_at', statementText: 'I really enjoy Nummo' }),
      claim({ predicate: 'mentors', statementText: 'Priya mentors me' }),
    ]);
    assert.equal(r.edges.length, 0);
    assert.equal(r.proposals.length, 2);
    assert.equal(r.proposals[0].predicate, 'enjoys_working_at', 'sorted by usage');
    assert.equal(r.proposals[0].usageCount, 2);
    assert.equal(r.proposals[1].usageCount, 1);
  });

  test('examples are bounded — a proposal seen 400 times carries 3 quotes, not 400', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      claim({ predicate: 'mentors', statementText: `example ${i}` }));
    const r = resolveRelationships(many);
    assert.equal(r.proposals[0].usageCount, 50);
    assert.equal(r.proposals[0].examples.length, 3);
  });

  test('a proposal is never also an edge', () => {
    const r = resolveRelationships([claim({ predicate: 'mentors' })]);
    assert.equal(r.edges.length, 0);
    assert.equal(r.stats.proposals, 1);
  });
});

describe('S7 — batch stats attribute every rejection', () => {
  test('rejections are counted by reason', () => {
    const r = resolveRelationships([
      claim(),                                                     // edge
      claim({ polarity: 'negated', claimId: 'c2' }),               // negated
      claim({ modality: 'intent', claimId: 'c3' }),                // modality
      claim({ predicate: 'prefers', object: { literal: 'x' }, claimId: 'c4' }), // literal
    ]);
    assert.equal(r.stats.edges, 1);
    assert.deepEqual(r.stats.byReason, {
      'negated-claim': 1, 'non-factual-modality:intent': 1, 'not-an-entity-object': 1,
    });
  });

  test('a non-array input yields nothing and does not throw', () => {
    for (const bad of [null, undefined, 'x', 42, {}]) {
      const r = resolveRelationships(bad);
      assert.equal(r.stats.seen, 0);
      assert.deepEqual(r.edges, []);
    }
  });
});
