/**
 * E6/PR-6 — the seven S4 gates.
 *
 * "S4 assumes the model will hallucinate and mechanically refuses anything not
 * grounded in a verbatim span. This is what allows a non-deterministic S3."
 *
 * So every gate is tested twice: once with input it must REFUSE, once with
 * input it must ADMIT. A firewall tested only on the things it blocks is
 * indistinguishable from a wall.
 *
 * Run: node --test src/brain/tests/claimValidator.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateAgainstSegment, validateBatch, isSensitivePredicate,
  OUTCOME, SOURCE_CEILING, UNKNOWN_TIER_CEILING,
} from '../understanding/claimValidator.js';
import { predicateNames } from '../../core/claims/predicateRegistry.js';

const SEG = 'I run product at Nummo and my co-founder Dev leads engineering.';

/** A claim that passes every gate, so each test can break exactly one thing. */
const good = (over = {}) => ({
  subject: 'self',
  predicate: 'works_at',
  object: { entity: 'Nummo' },
  objectKind: 'entity',
  polarity: 'asserted',
  modality: 'fact',
  statementText: 'I run product at Nummo',
  ...over,
});

const run = (claim, segment = SEG, opts = {}) => validateAgainstSegment(claim, segment, opts);

describe('the baseline claim is admitted — otherwise nothing below tests a gate', () => {
  test('a well-grounded claim passes all seven', () => {
    const r = run(good());
    assert.equal(r.outcome, OUTCOME.ADMIT, `${r.gate}: ${r.reason}`);
    assert.equal(r.gate, null);
  });
});

describe('gate ① — the quote must be verbatim', () => {
  test('REFUSES a paraphrase', () => {
    const r = run(good({ statementText: 'The user is employed at Nummo' }));
    assert.equal(r.outcome, OUTCOME.DISCARD);
    assert.equal(r.gate, 1);
  });

  test('REFUSES a missing quote — "a claim with no span is a hallucination with a database row"', () => {
    for (const q of [undefined, null, '', '   ']) {
      const r = run(good({ statementText: q }));
      assert.equal(r.gate, 1, `quote ${JSON.stringify(q)}`);
    }
  });

  test('ADMITS a case difference — providers routinely change case, and that is not a paraphrase', () => {
    assert.equal(run(good({ statementText: 'i RUN product at nummo' })).outcome, OUTCOME.ADMIT);
  });

  test('REFUSES when the segment is missing entirely', () => {
    // The most likely way a future caller disables this firewall is by not
    // passing the segment. It must fail closed.
    //
    // Called DIRECTLY rather than through the `run` helper: `run`'s
    // `segment = SEG` default parameter swallows an explicit `undefined` and
    // silently validated against the real segment, so the first version of
    // this test was asserting the opposite of what it read like. A default
    // argument in a test helper is a fine way to make a negative case vacuous.
    for (const s of [undefined, null, '', '   ']) {
      const r = validateAgainstSegment(good(), s);
      assert.equal(r.outcome, OUTCOME.DISCARD, `segment ${String(s)}`);
      assert.equal(r.reason, 'no-segment');
    }
  });
});

describe('gate ② — the quote must contain the object', () => {
  test('REFUSES a real span with a fabricated object', () => {
    // The attack this gate exists for: a genuine quote, real words, and an
    // object that was never said — a fabricated fact wearing valid provenance.
    const r = run(good({
      predicate: 'uses', object: { literal: 'Zeta' }, objectKind: 'literal',
      statementText: 'I run product at Nummo',
    }));
    assert.equal(r.outcome, OUTCOME.DISCARD);
    assert.equal(r.gate, 2);
  });

  test('ADMITS a literal that IS in the quote', () => {
    const r = run(good({
      predicate: 'uses', object: { literal: 'product' }, objectKind: 'literal',
      statementText: 'I run product at Nummo',
    }));
    assert.equal(r.outcome, OUTCOME.ADMIT, `${r.gate}: ${r.reason}`);
  });

  test('EXEMPTS entity objects, deliberately', () => {
    // "my co-founder Dev" → entity Dev: the surface form of an entity need not
    // appear, because S6 resolves it. Enforcing ② here would discard correct
    // claims, so the exemption is asserted rather than left implicit.
    const r = run(good({
      subject: 'self', predicate: 'knows', object: { entity: 'Dev' }, objectKind: 'entity',
      statementText: 'my co-founder Dev leads engineering',
    }));
    assert.equal(r.outcome, OUTCOME.ADMIT, `${r.gate}: ${r.reason}`);
  });

  test('REFUSES a quantity that is not in the quote', () => {
    const r = run(good({
      predicate: 'has_property', object: { quantity: 9999 }, objectKind: 'quantity',
      statementText: 'I run product at Nummo',
    }));
    assert.equal(r.gate, 2);
  });
});

describe('gate ③ — unknown predicates are PROPOSED, never auto-admitted', () => {
  test('an invented predicate is proposed, not admitted and not discarded', () => {
    // Collapsing propose into admit is the auto-registration this design
    // exists to prevent; collapsing it into discard throws away the signal
    // that the vocabulary is too small.
    const r = run(good({ predicate: 'enjoys_working_at' }));
    assert.equal(r.outcome, OUTCOME.PROPOSE);
    assert.equal(r.gate, 3);
    assert.equal(r.claim, null, 'a proposal is not a claim');
    assert.equal(r.proposal.predicate, 'enjoys_working_at');
  });

  test('every registered predicate passes gate ③', () => {
    // Guards against the registry and the validator drifting apart.
    for (const name of predicateNames()) {
      const r = run(good({ predicate: name, object: { entity: 'Nummo' }, objectKind: 'entity' }));
      assert.notEqual(r.gate, 3, `${name} was treated as unregistered`);
    }
  });
});

describe('gate ④ — enums', () => {
  test('REFUSES a polarity outside the enum', () => {
    assert.equal(run(good({ polarity: 'maybe' })).gate, 4);
  });
  test('REFUSES a modality outside the enum', () => {
    assert.equal(run(good({ modality: 'goal' })).gate, 4);
  });
  test('ADMITS negated — a negated claim is a claim', () => {
    assert.equal(run(good({ polarity: 'negated' })).outcome, OUTCOME.ADMIT);
  });
  test('ADMITS every legal modality', () => {
    for (const m of ['fact', 'intent', 'hypothetical', 'question', 'quote']) {
      assert.equal(run(good({ modality: m })).outcome, OUTCOME.ADMIT, m);
    }
  });
});

describe('gate ⑤ — the subject must be in the segment, or first person', () => {
  test('REFUSES a subject nobody mentioned', () => {
    const r = run(good({ subject: 'Priya' }));
    assert.equal(r.outcome, OUTCOME.DISCARD);
    assert.equal(r.gate, 5);
  });

  test('ADMITS a subject named in the segment', () => {
    const r = run(good({
      subject: 'Dev', predicate: 'works_at', object: { entity: 'Nummo' }, objectKind: 'entity',
      statementText: 'my co-founder Dev leads engineering',
    }));
    assert.equal(r.outcome, OUTCOME.ADMIT, `${r.gate}: ${r.reason}`);
  });

  test('ADMITS first person by GRAMMAR, not by surface form', () => {
    // "self" does not appear in the segment and must not need to.
    for (const s of ['self', 'I', 'we', 'our']) {
      assert.equal(run(good({ subject: s })).outcome, OUTCOME.ADMIT, s);
    }
  });
});

describe('gate ⑥ — no sensitive attributes (D3: no flag, no exception)', () => {
  test('REFUSES sensitive predicates across every prohibited category', () => {
    for (const p of [
      'has_health_condition', 'medical_history', 'diagnosed_with',
      'political_party', 'votes_for', 'religion_is', 'caste_is',
      'sexual_orientation', 'gender_identity', 'immigration_status',
      'visa_status', 'ethnic_background', 'criminal_conviction',
    ]) {
      assert.equal(isSensitivePredicate(p), true, `${p} is not blocked`);
      const r = run(good({ predicate: p }));
      assert.equal(r.gate, 6, `${p} reached gate ${r.gate}`);
    }
  });

  test('⑥ runs BEFORE ③, so a sensitive invention is DISCARDED not PROPOSED', () => {
    // The interaction that matters. Gate ③ can propose a predicate the model
    // invented, and a proposal is exactly how `has_health_condition` would
    // enter the vocabulary through the back door.
    const r = run(good({ predicate: 'has_health_condition' }));
    assert.equal(r.outcome, OUTCOME.DISCARD, 'must not be queued for review');
    assert.equal(r.gate, 6);
  });

  test('ARMED BUT INERT against the current registry — recorded, not assumed', () => {
    // None of the 31 registered predicates is sensitive, so this gate cannot
    // fire on an admitted claim today. That is worth pinning: if someone
    // registers a sensitive predicate, this fails rather than the blocklist
    // quietly starting to reject registered vocabulary.
    const blocked = predicateNames().filter(isSensitivePredicate);
    assert.deepEqual(blocked, [],
      `registered predicates are now blocked by D3: ${blocked.join(', ')} — resolve the conflict deliberately`);
  });

  test('does NOT block ordinary predicates that merely look adjacent', () => {
    // A blocklist that over-fires is a different failure with the same shape.
    for (const p of ['works_at', 'manages', 'prefers', 'located_in', 'has_status', 'has_property']) {
      assert.equal(isSensitivePredicate(p), false, `${p} is wrongly blocked`);
    }
  });
});

describe('gate ⑦ — the ceiling is applied here, not by the model', () => {
  test('a confident model is CAPPED by the source tier', () => {
    const r = run(good(), SEG, { sourceTier: 'chat', modelConfidence: 0.99 });
    assert.equal(r.outcome, OUTCOME.ADMIT);
    assert.equal(r.claim.confidence.extraction, SOURCE_CEILING.chat);
    assert.equal(r.claim.confidence.capped, true, 'the override is recorded, not silent');
    assert.equal(r.claim.confidence.modelAsked, 0.99, 'and what it asked for is kept for audit');
  });

  test('a modest model is NOT inflated to the ceiling', () => {
    const r = run(good(), SEG, { sourceTier: 'file', modelConfidence: 0.3 });
    assert.equal(r.claim.confidence.extraction, 0.3);
    assert.equal(r.claim.confidence.capped, false);
  });

  test('the tiers are ordered as D4 specifies', () => {
    assert.ok(SOURCE_CEILING.explicit > SOURCE_CEILING.file);
    assert.ok(SOURCE_CEILING.file > SOURCE_CEILING.chat);
    assert.ok(SOURCE_CEILING.chat > SOURCE_CEILING.inferred);
  });

  test('an UNKNOWN tier gets the floor, not the benefit of the doubt', () => {
    // A missing tier is a bug somewhere upstream. Defaulting high would let
    // that bug produce the most trusted claims in the store.
    const r = run(good(), SEG, { sourceTier: 'nonsense', modelConfidence: 1 });
    assert.equal(r.claim.confidence.extraction, UNKNOWN_TIER_CEILING);
    const r2 = run(good(), SEG, { modelConfidence: 1 });
    assert.equal(r2.claim.confidence.extraction, UNKNOWN_TIER_CEILING);
  });
});

describe('gate ORDER — the earliest problem is the one reported', () => {
  test('a claim failing ① and ⑤ reports ①', () => {
    // Reporting the later gate would send someone to fix the wrong thing.
    const r = run(good({ statementText: 'never said this', subject: 'Priya' }));
    assert.equal(r.gate, 1);
  });
});

describe('validateBatch — the per-gate histogram is the point', () => {
  test('splits admit / propose / discard and attributes each rejection', () => {
    const claims = [
      good(),                                               // admit
      good({ predicate: 'enjoys_working_at' }),             // propose (③)
      good({ statementText: 'never said this' }),           // discard ①
      good({ subject: 'Priya' }),                           // discard ⑤
      good({ predicate: 'has_health_condition' }),          // discard ⑥
    ];
    const r = validateBatch(claims, SEG, { sourceTier: 'chat', modelConfidence: 0.8 });

    assert.equal(r.stats.admitted, 1);
    assert.equal(r.stats.proposed, 1);
    assert.equal(r.stats.discarded, 3);
    assert.deepEqual(r.stats.byGate, { 1: 1, 5: 1, 6: 1 },
      'an extractor losing output to ① is a prompt problem, to ⑤ an entity problem, to ③ a vocabulary problem — one aggregate rate cannot tell them apart');
  });

  test('a non-array input yields nothing and does not throw', () => {
    for (const bad of [null, undefined, 'x', 42, {}]) {
      const r = validateBatch(bad, SEG);
      assert.equal(r.stats.seen, 0);
      assert.deepEqual(r.admitted, []);
    }
  });

  test('degenerate claims are discarded, never thrown on', () => {
    for (const bad of [null, undefined, 'claim', 42, []]) {
      assert.equal(validateAgainstSegment(bad, SEG).outcome, OUTCOME.DISCARD);
    }
  });
});
