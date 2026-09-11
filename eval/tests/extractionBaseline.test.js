/**
 * AQUA Eval — extraction baseline
 * Blueprint E2/PR-3
 *
 * Two jobs, and the second is the one that protects the number:
 *
 *   1. The baseline is REPRODUCIBLE — re-running the suite gives the committed
 *      figures. If it drifts, extraction behaviour changed, and that is either
 *      a regression or an improvement someone has to name.
 *
 *   2. The scorer is FAIR. A scorer that is accidentally harsh publishes a
 *      baseline that is too low, and then E6 looks like a triumph for reasons
 *      that have nothing to do with E6. The tests below feed the scorer
 *      SYNTHETIC PERFECT output and assert it scores 100% — proving the zeros
 *      in the real baseline come from the extractor, not from the grader.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSuite } from '../core/runner.mjs';
import suite from '../suites/extraction-core.suite.mjs';
import { extractWithCurrentEngine } from '../adapters/currentExtractor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(readFileSync(path.join(HERE, '../baselines/extraction-core.v1.json'), 'utf8'));

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── The adapter really drives the engine ─────────────────────────────────────

describe('extraction baseline — the adapter is not a stub', () => {
  test('it produces real facts for a real sentence', () => {
    // Three probes against this lane returned zero for everything before the
    // adapter was right — a wrong argument shape, a wrong field name, a missing
    // resolver step. Each would have published a 0% baseline and made any
    // replacement look miraculous. This test is what stops that recurring.
    const r = extractWithCurrentEngine('I run product at Nummo.');
    assert.ok(r.facts.length > 0, 'the adapter extracted nothing — it is miswired, not the engine');
    assert.ok(r.entities.some(e => e.canonical === 'Nummo'));
  });

  test('it stays silent on a request with no proper noun', () => {
    assert.equal(extractWithCurrentEngine('Fix this for me please.').facts.length, 0);
  });

  test('CLOSED: a request containing a proper noun no longer produces a fact', () => {
    // WAS a fact. "Explain how OAuth works to me." emitted one because OAuth
    // reads as an entity and the lane had no notion of a request. Six of the
    // ten false positives were this shape — the same failure class already
    // fixed once at the self-declaration gate, with the general path only now
    // catching up.
    //
    // An imperative stored as a fact does not stay harmless. It sits in the
    // world model and is retrieved later as though the user had told us
    // something about themselves, which is how a system ends up describing a
    // person back to themselves using their own to-do list.
    //
    // Measured: false_positives 10 → 8, silence_on_negatives 75% → 80%, and
    // detection_recall UNCHANGED at 61.3% — the gate removed only noise.
    assert.equal(extractWithCurrentEngine('Explain how OAuth works to me.').facts.length, 0);
    assert.ok(BASELINE.metrics.silence_on_negatives >= 0.8,
      `silence ${BASELINE.metrics.silence_on_negatives} — regression against 0.80`);
    assert.ok(BASELINE.metrics.detection_recall >= 0.61,
      'the request gate cost real claims — it must remove only noise');
  });

  test('FINDING: the speaker is recognised only when the sentence declares them', () => {
    // "I run product at Nummo." → self entity present.
    // "I moved to Bangalore last month." → NO self entity, only Bangalore.
    // Self recognition rides the self-declaration grammar, not the pronoun, so
    // first-person subjects are missed on most sentence shapes. That is the
    // direct cause of subject_recall sitting at 41%.
    assert.ok(extractWithCurrentEngine('I run product at Nummo.').entities.some(e => e.isSelf));
    assert.equal(extractWithCurrentEngine('I moved to Bangalore last month.').entities.some(e => e.isSelf), false);
  });
});

// ── The scorer is fair ───────────────────────────────────────────────────────

describe('extraction baseline — the scorer is not accidentally harsh', () => {
  const positive = suite.cases.find(c => c.cat === 'negation');

  test('PERFECT output scores 100% at every level', () => {
    // Synthetic output carrying everything the labels ask for. If this does not
    // score 1.0, the zeros in the published baseline are the grader's fault and
    // the whole PR is measuring itself.
    const perfect = {
      surfaces: [...positive.claims.map(c => (c.s === 'SELF' ? '__self__' : c.s.toLowerCase()))],
      facts: positive.claims.map(c => ({
        statement: positive.text, predicate: c.p, polarity: c.polarity,
        modality: c.modality, time: c.time ?? null,
      })),
    };
    const s = suite.score(positive, perfect);
    assert.equal(s.correct, true, 'perfect output was marked wrong — the scorer is harsh');
    assert.equal(s.subjectHits, positive.claims.length);
    assert.equal(s.predicateHits, positive.claims.length);
    assert.equal(s.fidelityHits, positive.claims.length);
  });

  test('predicate and fidelity are computed from the OUTPUT, not hardcoded to zero', () => {
    // The day E6 starts emitting predicates these begin scoring with no code
    // change here. A hardcoded zero would silently keep reporting failure.
    const m = suite.metrics([
      { kind: 'positive', cat: 'negation', emitted: true, claims: 1, subjectHits: 1, predicateHits: 1, fidelityHits: 1, correct: true },
    ]);
    assert.equal(m.predicate_accuracy, 1);
    assert.equal(m.fidelity_accuracy, 1);
  });

  test('a negative that stays silent is correct; one that fires is not', () => {
    const neg = suite.cases.find(c => c.cat === 'negative');
    assert.equal(suite.score(neg, { facts: [], surfaces: [] }).correct, true);
    assert.equal(suite.score(neg, { facts: [{ statement: neg.text }], surfaces: [] }).correct, false);
  });

  test('precision is reported separately, never averaged into recall', () => {
    // Folding silence-on-negatives into one accuracy figure is how an
    // extractor that fires on everything hides.
    const m = suite.metrics([
      { kind: 'positive', cat: 'identity', emitted: true, claims: 1, subjectHits: 1, predicateHits: 0, fidelityHits: 0, correct: false },
      { kind: 'negative', cat: 'negative', emitted: true, correct: false },
    ]);
    assert.equal(m.silence_on_negatives, 0);
    assert.equal(m.false_positives, 1);
    assert.equal(m.detection_recall, 1);
  });
});

// ── The baseline reproduces ──────────────────────────────────────────────────

describe('extraction baseline — reproduces the committed figures', () => {
  test('every case executes — a partial baseline is not a baseline', async () => {
    const { result } = await runSuite(suite);
    assert.equal(result.coverage.total, 200);
    assert.equal(result.coverage.executed, 200);
    assert.equal(result.coverage.complete, true);
  });

  test('the headline figures match what is committed', async () => {
    const { result } = await runSuite(suite);
    for (const key of [
      'detection_recall', 'subject_recall', 'predicate_accuracy',
      'fidelity_accuracy', 'silence_on_negatives', 'overall_strict_accuracy',
    ]) {
      assert.ok(near(result.metrics[key], BASELINE.metrics[key]),
        `${key} moved: committed ${BASELINE.metrics[key]}, measured ${result.metrics[key]} — ` +
        'extraction behaviour changed. Regenerate the baseline deliberately, in a PR that says why.');
    }
  });

  test('the baseline records the conditions that produced it', () => {
    assert.ok(BASELINE.suiteFingerprint, 'no dataset fingerprint — two runs over different data would look comparable');
    assert.ok(BASELINE.recordedAt);
    assert.equal(BASELINE.caseCount, 200);
    assert.match(BASELINE.note, /E6 must beat/);
  });
});

// ── What the baseline actually says ──────────────────────────────────────────

describe('extraction baseline — the findings, pinned', () => {
  test('CLOSED: fidelity is read and STORED — polarity, modality, time', () => {
    // WAS 0.0%. The lane emitted a verbatim statement and an entity list, so
    // "I don't use Kubernetes" was stored as an ASSERTED fact. The text kept
    // the "don't", but nothing in the DATA said the claim was negative, and
    // every consumer had to re-derive it from prose — two derivations of the
    // same thing that can disagree, silently, on the way to the model.
    //
    // Fidelity is now read at write time (`claimFidelity.js`). These are
    // GRAMMATICAL properties of the sentence, which is why they were reachable
    // without the claim schema: "I don't", "I want to", "if we", "she said",
    // "last month" are all marked in the surface form. Reading them is parsing.
    assert.ok(BASELINE.metrics.fidelity_accuracy >= 0.55,
      `fidelity ${BASELINE.metrics.fidelity_accuracy} — regression against 0.551`);
  });

  test('OPEN: predicate is STILL zero, and is not being faked', () => {
    // A predicate is a relation from a controlled vocabulary — choosing
    // `works_at` over `role_is` is a semantic judgement that belongs to E5's
    // schema and E6's model-backed pipeline. Surface rules guessing predicate
    // names would score against THIS dataset and transfer nowhere.
    //
    // So this stays 0, and the test is here to make sure it stays honestly 0.
    // If it moves, the question is not "did it improve" but "did someone fit
    // a predicate vocabulary to the labels".
    assert.equal(BASELINE.metrics.predicate_accuracy, 0,
      'predicate moved — verify a real schema landed, not a regex fitted to the labels');
  });

  test('detection improved, and NOT by trading away silence', () => {
    // WAS 61.3%, now 71.9%. Tier 2 of the solo-proper-noun pass required a
    // copula, so every third party who DOES something was invisible: "Dev
    // reports to me", "Rahul joined the billing team". detection_people alone
    // went 55.0% → 95.0%.
    //
    // The second assertion is the one that matters. Recall bought by admitting
    // more junk is not an improvement, and the honest check is that BOTH
    // directions moved: false positives 8 → 4 over the same change.
    assert.ok(BASELINE.metrics.detection_recall >= 0.71,
      `detection ${BASELINE.metrics.detection_recall} — regression against 0.719`);
    assert.ok(BASELINE.metrics.silence_on_negatives >= 0.90,
      'recall rose while silence fell — that is a trade, not a gain');
  });

  test('temporal and negation remain the weakest categories', () => {
    const m = BASELINE.metrics;
    assert.ok(m.detection_temporal < m.detection_identity);
    assert.ok(m.detection_negation < m.detection_identity);
  });

  test('there are real false positives on the negatives', () => {
    // 10 of 40. Requests and questions containing a proper noun still produce
    // a fact — the same failure class as "I need to check the logs", which was
    // fixed once at the self-declaration gate and is still present here.
    assert.ok(BASELINE.metrics.false_positives > 0);
    assert.ok(BASELINE.metrics.silence_on_negatives < 1);
  });
});
