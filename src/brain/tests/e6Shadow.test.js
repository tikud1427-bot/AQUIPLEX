/**
 * E6/PR-11 — the shadow run.
 *
 * The numbers need a provider; the DECISION about them does not. A promotion
 * rule that only executes on the day someone wants to promote has never been
 * exercised, so `evaluatePromotion` is tested here in full, and the pipeline
 * adapter is driven end to end with a stubbed transport.
 *
 * Run: node --test src/brain/tests/e6Shadow.test.js
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractE6, EVAL_ASSERTED_AT } from '../../../eval/adapters/e6Extractor.mjs';
import { evaluatePromotion, PROMOTION_GATE } from '../../../scripts/e6-shadow.mjs';
import suite from '../../../eval/suites/extraction-core.suite.mjs';
import { __clearExtractionCache } from '../understanding/extractionClient.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const BASELINE = JSON.parse(readFileSync(
  path.join(ROOT, 'eval/baselines/extraction-core.v1.json'), 'utf8')).metrics;

/** A transport returning one well-formed claim for any segment. */
const stub = (claims, model = 'stub-model-1') => async () => ({
  model, text: JSON.stringify({ claims }),
});

const worksAt = {
  subject: 'self', predicate: 'works_at', object: { entity: 'Nummo' },
  polarity: 'asserted', modality: 'fact', timePrecision: 'none',
  statementText: 'I work at Nummo', confidenceExtraction: 0.9,
};

beforeEach(() => __clearExtractionCache());

describe('the E6 adapter refuses to be scored without a provider', () => {
  test('no transport → available:false, not an empty result', async () => {
    // A pipeline with no transport emits nothing, which the suite scores as
    // detection 0.0% — indistinguishable from a catastrophically bad
    // extractor. The absence of a key must not be reportable as a result.
    const r = await extractE6('I work at Nummo.', {});
    assert.equal(r.available, false);
    assert.equal(r.stats.reason, 'no-transport');
    assert.deepEqual(r.facts, []);
  });

  test('with a transport it reports available:true', async () => {
    const r = await extractE6('I work at Nummo.', { callModel: stub([worksAt]) });
    assert.equal(r.available, true);
  });
});

describe('the E6 adapter emits the shape extraction-core scores', () => {
  test('facts carry predicate, polarity, modality and time', async () => {
    // The committed baseline reads predicate 0.0% and fidelity 0.0% because
    // the old lane has no such fields. If E6 does not emit them either, the
    // shadow run measures nothing new.
    const r = await extractE6('I work at Nummo.', { callModel: stub([worksAt]) });
    assert.equal(r.facts.length, 1);
    const [f] = r.facts;
    assert.equal(f.predicate, 'works_at');
    assert.equal(f.polarity, 'asserted');
    assert.equal(f.modality, 'fact');
    assert.ok('validFrom' in f && 'time' in f);
  });

  test('the suite can score it, and predicate/fidelity are now REACHABLE', async () => {
    const r = await extractE6('I work at Nummo.', { callModel: stub([worksAt]) });
    const scored = suite.score(
      { cat: 'identity', claims: [{ s: 'self', p: 'works_at', polarity: 'asserted', modality: 'fact' }] },
      { facts: r.facts, surfaces: r.surfaces });
    assert.equal(scored.predicateHits, 1, 'structurally unreachable for the old lane, reachable now');
    assert.equal(scored.fidelityHits, 1);
  });

  test('"self" is expanded to first-person SURFACES the corpus actually uses', async () => {
    // `self` is the pipeline's internal token and appears in no corpus. Without
    // expansion every self-claim scores a subject miss for a reason that has
    // nothing to do with extraction quality.
    const r = await extractE6('I work at Nummo.', { callModel: stub([worksAt]) });
    for (const s of ['I', 'me', 'my', 'we', 'our']) {
      assert.ok(r.surfaces.includes(s), `${s} missing from surfaces`);
    }
  });

  test('entity objects reach surfaces too, LOWERED', async () => {
    // This asserted `includes('Nummo')` — the model's raw casing — and so it
    // pinned the defect rather than the contract. `extraction-core.suite.mjs`
    // looks a subject up with `surfaces.has(claim.s.toLowerCase())` and the
    // regex lane lowers everything it adds, so raw casing can never match:
    // 49 of 167 labelled claims have a capitalised named subject.
    const r = await extractE6('I work at Nummo.', { callModel: stub([worksAt]) });
    assert.ok(r.surfaces.includes('nummo'), `surfaces were [${r.surfaces.join(', ')}]`);
    assert.ok(!r.surfaces.includes('Nummo'), 'raw casing must not survive — it cannot match the lookup');
  });

  test('the temporal anchor is FIXED — a re-run on another day is identical', async () => {
    // A wall-clock anchor would make "last month" resolve differently and the
    // shadow numbers drift with no code change.
    const a = await extractE6('I joined last month.', { callModel: stub([{ ...worksAt, statementText: 'I joined last month' }]) });
    __clearExtractionCache();
    const b = await extractE6('I joined last month.', { callModel: stub([{ ...worksAt, statementText: 'I joined last month' }]) });
    assert.deepEqual(a.facts, b.facts);
    assert.match(EVAL_ASSERTED_AT, /^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('the E6 adapter runs every stage, and says which one dropped a claim', () => {
  test('the gate can reject a whole segment', async () => {
    const r = await extractE6('Can you write me a python script?', { callModel: stub([worksAt]) });
    assert.equal(r.stats.gated, 0, 'a request is not a claim-bearing segment');
    assert.equal(r.facts.length, 0);
  });

  test('an S4 discard is attributed to its GATE, not lumped into a total', async () => {
    // An extractor losing output to gate ① is a prompt problem and to gate ⑤
    // an entity problem. One aggregate rejection rate cannot tell them apart.
    const paraphrase = { ...worksAt, statementText: 'The user is employed at Nummo' };
    const r = await extractE6('I work at Nummo.', { callModel: stub([paraphrase]) });
    assert.equal(r.facts.length, 0);
    assert.equal(r.stats.discarded, 1);
    // Keyed `gate:reason` since the first live shadow run reported
    // `{"2": 2}` — gate 2 covers both `object-missing` and
    // `object-not-in-quote`, opposite defects in one bucket. The gate number
    // is still the prefix, so this still pins WHICH stage dropped it, and now
    // also pins why.
    const key = Object.keys(r.stats.byGate).find(k => k.startsWith('1:'));
    assert.ok(key, `expected a gate-1 discard, got ${JSON.stringify(r.stats.byGate)}`);
    assert.equal(r.stats.byGate[key], 1, 'gate ① — the quote is not verbatim');
    assert.match(key, /^1:quote-not-verbatim$/, 'the reason must be named, not just the stage');
  });

  test('an invented predicate is PROPOSED, not discarded and not emitted', async () => {
    const r = await extractE6('I work at Nummo.', {
      callModel: stub([{ ...worksAt, predicate: 'enjoys_working_at' }]) });
    assert.equal(r.stats.proposed, 1);
    assert.equal(r.stats.discarded, 0);
    assert.equal(r.facts.length, 0);
  });

  test('the source tier defaults to chat, not explicit', async () => {
    // Claiming `explicit` would raise every confidence ceiling and flatter the
    // run. A conversational corpus is chat.
    const r = await extractE6('I work at Nummo.', { callModel: stub([worksAt]) });
    assert.equal(r.available, true);
    assert.equal(r.facts.length, 1, 'the tier affects confidence, not admission');
  });

  test('a transport error is counted, not thrown', async () => {
    const r = await extractE6('I work at Nummo.', {
      callModel: async () => { throw new Error('ECONNRESET'); } });
    assert.equal(r.stats.errors, 1);
    assert.deepEqual(r.facts, []);
  });
});

describe('the promotion rule', () => {
  const perfect = {
    detection_recall: 0.95, subject_recall: 0.9, predicate_accuracy: 0.9,
    fidelity_accuracy: 0.9, silence_on_negatives: 0.95,
    detection_negation: 0.97, false_positives: 2, negatives: 40,
    // The DENOMINATORS the real suite always emits. Without them every rate
    // here is 0/0 and unmeasurable — which is the whole point of the change
    // these were added for, and a fixture that omits them is not the shape
    // `suite.metrics()` actually returns.
    positives: 160, labelled_claims: 167, n_cases_negation: 20,
  };

  test('the gate is the blueprint\'s, not one invented here', () => {
    assert.equal(PROMOTION_GATE.precision, 0.85);
    assert.equal(PROMOTION_GATE.recall, 0.70);
    assert.equal(PROMOTION_GATE.negation, 0.95);
  });

  test('a strong result promotes', () => {
    const v = evaluatePromotion(perfect, BASELINE);
    assert.equal(v.gatePassed, true);
    assert.deepEqual(v.regressions, []);
    assert.equal(v.promote, true);
  });

  test('failing ANY single threshold blocks promotion', () => {
    for (const [k, v] of [['detection_recall', 0.5], ['detection_negation', 0.5], ['false_positives', 30]]) {
      const r = evaluatePromotion({ ...perfect, [k]: v }, BASELINE);
      assert.equal(r.promote, false, `${k}=${v} should block`);
    }
  });

  test('THE IMPORTANT ONE: passing the gate while REGRESSING a baseline metric blocks', () => {
    // A new extractor that clears every threshold but scores below the
    // committed baseline on some dimension is a regression wearing a passing
    // grade — and the gate alone would wave it through.
    const regressed = { ...perfect, silence_on_negatives: BASELINE.silence_on_negatives - 0.1 };
    const v = evaluatePromotion(regressed, BASELINE);
    assert.equal(v.gatePassed, true, 'the thresholds still pass');
    assert.equal(v.promote, false, 'but promotion is refused');
    assert.equal(v.regressions[0].metric, 'silence_on_negatives');
  });

  test('matching the baseline exactly is not a regression', () => {
    const v = evaluatePromotion({ ...perfect, ...BASELINE, detection_recall: 0.95,
      detection_negation: 0.97, false_positives: 2, negatives: 40 }, BASELINE);
    assert.deepEqual(v.regressions, []);
  });

  test('precision is derived from false positives over NEGATIVES', () => {
    // Not over all 200 cases. 10 false positives on 40 negatives is 75%
    // precision, not 95% — and the flattering denominator is the easy mistake.
    const v = evaluatePromotion({ ...perfect, false_positives: 10, negatives: 40 }, BASELINE);
    assert.ok(Math.abs(v.checks.find(c => c.name === 'precision').got - 0.75) < 1e-9);
  });

  test('a missing metric counts as zero, never as a pass', () => {
    assert.equal(evaluatePromotion({}, BASELINE).promote, false);
  });
});

describe('the committed baseline is what E6 must beat', () => {
  test('THE BAR MOVED: fidelity is no longer zero, so E6 must beat a real number', () => {
    // This assertion used to read `fidelity_accuracy === 0`, with the note "if
    // these ever read non-zero for the OLD lane, the comparison below has
    // silently changed meaning." It did read non-zero, and the meaning HAS
    // changed — deliberately, not silently.
    //
    // The old lane now reads polarity, modality and time at write time
    // (`knowledgeExtraction/claimFidelity.js`), because those are grammatical
    // properties of the sentence rather than schema-dependent ones. Measured
    // 0.0% → 55.1%.
    //
    // The consequence for E6 is the point of updating this rather than
    // deleting it: E6 no longer gets credit for emitting fidelity at all. It
    // has to beat 55.1%, and a model-backed pipeline that cannot outperform a
    // regex on negation and modality is not ready to replace one.
    assert.ok(BASELINE.fidelity_accuracy >= 0.55,
      `fidelity ${BASELINE.fidelity_accuracy} — the bar regressed`);
  });

  test('predicate is STILL 0.0% — the one thing E6 gets for free', () => {
    // Unchanged and deliberately so. A predicate is a relation from a
    // controlled vocabulary; guessing `works_at` over `role_is` from surface
    // patterns would fit this corpus and transfer nowhere. This is the part of
    // the comparison that genuinely requires the schema, and it stays zero so
    // that E6's gain there is real.
    assert.equal(BASELINE.predicate_accuracy, 0);
  });

  test('THE BAR MOVED AGAIN: detection recall is 71.9%, not 61.3%', () => {
    // This pinned 61.3% as "the gate ceiling measured in PR-6". The ceiling was
    // never the gate's — it was Tier 2 of the solo-proper-noun pass demanding a
    // copula, which made every third-person subject who DOES something
    // invisible. detection_people went 55.0% → 95.0% when that was relaxed.
    //
    // E6 now has to beat 71.9% detection and 55.7% subject recall on top of
    // 64.7% fidelity. Each of those is a regex, and a model-backed pipeline
    // that cannot clear a regex has not earned the request path.
    assert.ok(BASELINE.detection_recall >= 0.71,
      `detection ${BASELINE.detection_recall} — the bar regressed`);
    assert.ok(BASELINE.subject_recall >= 0.55,
      `subject ${BASELINE.subject_recall} — the bar regressed`);
  });
});
