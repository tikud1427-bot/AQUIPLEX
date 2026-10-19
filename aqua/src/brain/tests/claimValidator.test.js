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
  OUTCOME, SOURCE_CEILING, UNKNOWN_TIER_CEILING, resolveSegmentPolarityConflicts, canonText,
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

describe("gate ②′ — an inflected literal is GROUNDED to the quote's own words, never relaxed", () => {
  const JUN = 'Jun is helping me prepare the investor deck.';
  const jun = (literal) => run(good({
    subject: 'Jun', predicate: 'task_owner', object: { literal }, objectKind: 'literal',
    statementText: 'Jun is helping me prepare the investor deck',
  }), JUN);

  test('the live loss: "help me prepare…" for "helping me prepare…" is admitted, stored as the verbatim span', () => {
    const r = jun('help me prepare the investor deck');
    assert.equal(r.outcome, OUTCOME.ADMIT, `${r.gate}: ${r.reason}`);
    assert.equal(r.claim.object.literal, 'helping me prepare the investor deck');
    assert.ok('Jun is helping me prepare the investor deck'.includes(r.claim.object.literal), 'the stored object must be verbatim in the quote');
    assert.deepEqual(r.claim.objectGrounded, { from: 'help me prepare the investor deck', rule: 'inflection' });
  });

  test('an exact literal is untouched (no grounding record)', () => {
    const r = jun('prepare the investor deck');
    assert.equal(r.claim.object.literal, 'prepare the investor deck');
    assert.equal(r.claim.objectGrounded, undefined);
  });

  test('STILL REFUSES: a different word, not an inflection ("pitch deck" for "investor deck")', () => {
    assert.equal(jun('helping me prepare the pitch deck').gate, 2);
  });

  test('STILL REFUSES: two inflected words', () => {
    assert.equal(jun('helps me prepares the investor deck').gate, 2);
  });

  test('STILL REFUSES: an added word, or words out of order', () => {
    assert.equal(jun('helping me prepare the new investor deck').gate, 2);
    assert.equal(jun('prepare me helping the investor deck').gate, 2);
  });

  test('STILL REFUSES: a one-word literal with no exact anchor ("helps" for "helping")', () => {
    // ("help" alone passes the ORIGINAL gate ② as a substring of "helping";
    // "helps" is not a substring, so only grounding could admit it — and must not.)
    assert.equal(jun('helps').gate, 2);
  });

  test('STILL REFUSES: a fabricated object on a real quote (the attack gate ② exists for)', () => {
    const r = run(good({ predicate: 'uses', object: { literal: 'Zeta Labs' }, objectKind: 'literal', statementText: 'I run product at Nummo' }));
    assert.equal(r.gate, 2);
  });

  test('STILL REFUSES: a quantity is never grounded by inflection', () => {
    // The same object as a LITERAL would be grounded (one inflected word);
    // as a quantity it must be refused.
    const q = 'We have 57 clinic now';
    assert.equal(run(good({ predicate: 'has_property', object: { literal: '57 clinics now' }, objectKind: 'literal', statementText: q }), q).outcome, OUTCOME.ADMIT);
    const r = run(good({ predicate: 'has_property', object: { quantity: '57 clinics now' }, objectKind: 'quantity', statementText: q }), q);
    assert.equal(r.gate, 2);
  });

  test('negation words must match exactly — "not" is not an inflection of anything', () => {
    const r = run(good({ subject: 'Jun', predicate: 'task_owner', object: { literal: 'now helping on the deck' }, objectKind: 'literal', statementText: 'Jun is not helping on the deck' }), 'Jun is not helping on the deck');
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

// D6 (2026-10-05) — gate ⑤b: a subject the sentence names BY REFERENCE.
describe('⑤b subject resolved from context', async () => {
  const { validateAgainstSegment, contextReference } = await import('../understanding/claimValidator.js');
  const ctx = new Map([["tidepool's backend", ['Go']], ['harbor', ['Kotlin']]]);
  const c = (subject, quote, object = { entity: 'Rust' }) => ({
    subject, predicate: 'uses', object, polarity: 'asserted', modality: 'fact', statementText: quote,
  });
  const run = (claim, seg, contextSubjects = ctx) => validateAgainstSegment(claim, seg, { sourceTier: 'chat', contextSubjects });

  test('a pronoun refers to a context subject → admitted, with the resolution recorded', () => {
    const v = run(c("Tidepool's backend", "It's written in Rust"), "It's written in Rust.");
    assert.equal(v.outcome, 'admit');
    assert.deepEqual(v.claim.contextResolved, { subject: "Tidepool's backend", via: 'pronoun' });
  });

  test('a word of its name refers to it ("the backend")', () => {
    assert.equal(run(c("Tidepool's backend", 'The backend is Rust now'), 'The backend is Rust now.').claim.contextResolved.via, 'name');
  });

  test('the value it held refers to it ("Not Go — Rust")', () => {
    const v = run(c("Tidepool's backend", 'Not Go — Rust'), 'Not Go — Rust.');
    assert.deepEqual(v.claim.contextResolved, { subject: "Tidepool's backend", via: 'value', value: 'Go' });
  });

  test('a subject the extractor was NOT given is still refused — no invented names', () => {
    assert.equal(run(c('Mercury backend', "It's written in Rust"), "It's written in Rust.").reason, 'subject-not-in-segment');
  });

  test('a context subject the sentence does not refer to at all is refused', () => {
    assert.equal(run(c('Harbor', 'Rust is great'), 'Rust is great.').reason, 'subject-not-in-segment');
  });

  test('without context, gate ⑤ behaves exactly as before', () => {
    assert.equal(run(c("Tidepool's backend", "It's written in Rust"), "It's written in Rust.", null).reason, 'subject-not-in-segment');
    assert.equal(contextReference('x', 'it is', null), null);
  });
});

describe('gate ⑧ — one segment cannot assert and negate the same fact (2026-10-06)', () => {
  // Measured on E6 extract-v4: "Priya no longer works at Aquiplex" came back as
  // a negated works_at AND an asserted twin (open validity, present tense).
  const SEG8 = 'Priya no longer works at Aquiplex.';
  const claim = polarity => ({
    subject: 'Priya', predicate: 'works_at', object: { entity: 'Aquiplex' }, objectKind: 'entity',
    polarity, modality: 'fact', statementText: 'Priya no longer works at Aquiplex',
  });

  test('the asserted twin is discarded, the negation kept', () => {
    const r = resolveSegmentPolarityConflicts([claim('negated'), claim('asserted')]);
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0].polarity, 'negated');
    assert.equal(r.discarded[0].reason, 'polarity-conflict-in-segment');
    assert.equal(r.discarded[0].gate, 8);
  });

  test('order does not matter', () => {
    const r = resolveSegmentPolarityConflicts([claim('asserted'), claim('negated')]);
    assert.deepEqual(r.kept.map(c => c.polarity), ['negated']);
  });

  test('a change with DIFFERENT objects keeps both ("from Lisbon to Porto")', () => {
    const lisbon = { ...claim('negated'), subject: 'self', predicate: 'located_in', object: { entity: 'Lisbon' } };
    const porto = { ...claim('asserted'), subject: 'self', predicate: 'located_in', object: { entity: 'Porto' } };
    assert.equal(resolveSegmentPolarityConflicts([lisbon, porto]).kept.length, 2);
  });

  test('a different modality is not a conflict (negated fact vs asserted intent)', () => {
    const intent = { ...claim('asserted'), modality: 'intent' };
    assert.equal(resolveSegmentPolarityConflicts([claim('negated'), intent]).kept.length, 2);
  });

  test('subject casing and object casing do not hide a twin', () => {
    const twin = { ...claim('asserted'), subject: 'priya', object: { entity: 'aquiplex' } };
    assert.equal(resolveSegmentPolarityConflicts([claim('negated'), twin]).kept.length, 1);
  });

  test('validateBatch applies ⑧ and reports it in the histogram', () => {
    const r = validateBatch([claim('negated'), claim('asserted')], SEG8, { sourceTier: 'chat' });
    assert.equal(r.admitted.length, 1);
    assert.equal(r.admitted[0].polarity, 'negated');
    assert.equal(r.stats.byGate[8], 1);
  });
});

describe('gate ① compares words, not contraction spellings (2026-10-06)', () => {
  const neg = quote => ({ subject: 'Dev', predicate: 'member_of', object: { entity: 'platform team' }, objectKind: 'entity',
    polarity: 'negated', modality: 'fact', statementText: quote });
  test('"is not" quoted for "isn\'t" is the same words → admitted (production-extractor miss, negation-004)', () => {
    assert.equal(validateAgainstSegment(neg('Dev is not on the platform team'), "Dev isn't on the platform team.", { sourceTier: 'chat' }).outcome, 'admit');
  });
  test('curly apostrophes and can\'t/won\'t canonicalise too', () => {
    assert.equal(validateAgainstSegment(neg('Dev isn’t on the platform team'), "Dev isn't on the platform team.", { sourceTier: 'chat' }).outcome, 'admit');
    assert.equal(validateAgainstSegment({ ...neg('I can not join'), subject: 'self', predicate: 'member_of' }, "I can't join the platform team.", { sourceTier: 'chat' }).outcome, 'admit');
  });
  test('a paraphrase is STILL refused — only contraction spelling is canonical', () => {
    assert.equal(validateAgainstSegment(neg('Dev is no longer on the platform team'), "Dev isn't on the platform team.", { sourceTier: 'chat' }).reason, 'quote-not-verbatim');
    assert.equal(canonText("Don't"), 'do not');
  });
});
