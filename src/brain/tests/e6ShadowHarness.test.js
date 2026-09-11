/**
 * The E6 shadow harness — the five defects the first real run exposed.
 *
 * That run reported `subject_recall 0%`, `silence_on_negatives 0%`,
 * `negation 0% FAIL` and a verdict of DO NOT PROMOTE. Four of those five
 * numbers were harness defects, not extraction defects, and every one of them
 * was invisible to the existing tests — reverting each fix left the whole
 * `e6Shadow.test.js` suite green. That is what this file is for.
 *
 * BITE, MEASURED (revert the named change → count failures):
 *   `__self__` sentinel in the E6 adapter    → 3 fail
 *   stratified `--limit`                     → 4 fail
 *   0/0 reports null, not 0.0                → 3 fail
 *   partial runs refuse baseline comparison  → 2 fail
 *   discards keyed by gate AND reason        → 2 fail
 *   noise floor on the regression check      → 2 fail
 *   unmeasured noise returns null, not false → 3 fail
 *
 * ONE THING HERE IS NOT PINNED AND SAYS SO. `--repeat` clears the extraction
 * cache between passes; without that, repeats replay pass 1 and report a spread
 * of 0.000 — a confident wrong answer to the exact question --repeat asks.
 * Proving it needs a provider, which this environment does not have, so it is
 * declared rather than claimed. A pin whose stated bite is zero is worse than
 * no pin.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stratify, evaluatePromotion, spread, isRealRegression,
  MAX_PASS_ERROR_RATE, ABORT_AFTER_CONSECUTIVE_ERRORS, MAX_STALL_WAIT_MS,
  passIsValid, pickReportedPass, PROMOTION_GATE } from '../../../scripts/e6-shadow.mjs';
import suite from '../../../eval/suites/extraction-core.suite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../../../eval/datasets/extraction-core.v1.json'), 'utf8'));

// ── 1. The sentinel ──────────────────────────────────────────────────────────

describe('E6 adapter — the self sentinel the suite actually checks', () => {
  test('a self-claim contributes __self__, not just first-person surfaces', async () => {
    // `extraction-core.suite.mjs` scores a self-subject with exactly
    // `surfaces.has('__self__')`. The adapter emitted 'I', 'me', 'my', 'we',
    // 'our' and never the sentinel, so all 20 SELF claims in the first shadow
    // slice missed — subject_recall 0.00 against the regex lane's 0.55 on the
    // same cases, while detection ran at 0.90.
    const { extractE6 } = await import('../../../eval/adapters/e6Extractor.mjs');
    const { __clearExtractionCache } = await import('../understanding/extractionClient.js');
    __clearExtractionCache();
    // The exact fixture shape e6Shadow.test.js already proves the validator
    // admits. Inventing a second one here risks failing on contract grounds and
    // reading as a sentinel bug — which is how the first attempt failed.
    const worksAt = {
      subject: 'self', predicate: 'works_at', object: { entity: 'Nummo' },
      polarity: 'asserted', modality: 'fact', timePrecision: 'none',
      statementText: 'I work at Nummo', confidenceExtraction: 0.9,
    };
    const r = await extractE6('I work at Nummo.', {
      callModel: async () => ({ text: JSON.stringify({ claims: [worksAt] }), model: 'test/model' }),
    });
    assert.ok(r.surfaces.includes('__self__'),
      `surfaces were [${r.surfaces.join(', ')}] — the suite checks for __self__ and nothing else`);
  });

  test('the suite scores that surface set as a subject hit', () => {
    // End-to-end through the real scorer, so the two halves cannot drift apart
    // again with each looking correct alone.
    const selfCase = DS.cases.find(c => c.claims?.some(cl => cl.s === 'SELF'));
    assert.ok(selfCase, 'dataset has no SELF-subject case');
    const scored = suite.score(selfCase, {
      facts: selfCase.claims.map(() => ({ subject: 'self', predicate: 'x' })),
      surfaces: ['__self__'],
    });
    assert.equal(scored.subjectHits, selfCase.claims.length);
  });

  test('a NAMED subject is lowered to match the suite lookup', async () => {
    // The suite does `surfaces.has(claim.s.toLowerCase())` and the regex lane
    // lowers everything it adds. This adapter added the model's raw casing, so
    // "Priya" never matched "priya" — 49 of 167 labelled claims (29%) have a
    // capitalised named subject and could not score however well the model read
    // them. Found only after the `__self__` fix stopped masking it.
    const { extractE6 } = await import('../../../eval/adapters/e6Extractor.mjs');
    const { __clearExtractionCache } = await import('../understanding/extractionClient.js');
    __clearExtractionCache();
    // The proven `worksAt` shape with ONLY the subject changed. A fixture that
    // also varies the predicate gets rejected by the contract gate and reads as
    // a casing bug — which is exactly how the first attempt at this test failed.
    const claim = {
      subject: 'Priya', predicate: 'works_at', object: { entity: 'Nummo' },
      polarity: 'asserted', modality: 'fact', timePrecision: 'none',
      statementText: 'Priya works at Nummo', confidenceExtraction: 0.9,
    };
    const r = await extractE6('Priya works at Nummo.', {
      callModel: async () => ({ text: JSON.stringify({ claims: [claim] }), model: 'test/model' }),
    });
    assert.equal(r.facts.length, 1, `claim was discarded: ${JSON.stringify(r.stats.byGate)}`);
    assert.ok(r.surfaces.includes('priya'),
      `surfaces were [${r.surfaces.join(', ')}] — the suite lowercases the label before lookup`);
    assert.ok(!r.surfaces.includes('Priya'), 'raw casing must not survive; it can never match');
  });

  test('the suite scores a lowered named subject as a hit', () => {
    const named = DS.cases.find(c => c.claims?.some(cl => cl.s !== 'SELF' && cl.s !== cl.s.toLowerCase()));
    assert.ok(named, 'dataset has no capitalised named subject');
    const subj = named.claims.find(cl => cl.s !== 'SELF').s;
    const hit = suite.score(named, {
      facts: named.claims.map(() => ({ subject: subj, predicate: 'x' })),
      surfaces: [subj.toLowerCase(), '__self__'],
    });
    const miss = suite.score(named, {
      facts: named.claims.map(() => ({ subject: subj, predicate: 'x' })),
      surfaces: [subj, '__self__'],
    });
    assert.ok(hit.subjectHits > miss.subjectHits,
      'lowering must matter — if it does not, this pin proves nothing');
  });

  test('the first-person forms are NOT sufficient on their own', () => {
    // Pins the exact failure, so restoring the old expansion fails here.
    const selfCase = DS.cases.find(c => c.claims?.some(cl => cl.s === 'SELF'));
    const scored = suite.score(selfCase, {
      facts: selfCase.claims.map(() => ({ subject: 'self', predicate: 'x' })),
      surfaces: ['self', 'I', 'me', 'my', 'we', 'our'],
    });
    assert.equal(scored.subjectHits, 0, 'surface forms alone should not score — the suite wants the sentinel');
  });
});

// ── 2. Stratified sampling ───────────────────────────────────────────────────

describe('--limit samples the dataset rather than slicing its front', () => {
  test('a small limit still reaches negatives', () => {
    // `extraction-core.v1` is grouped by category: cases 0-19 are all
    // `identity` and the first negative is at index 160. A prefix of 20
    // contained no negatives at all, which is where three of the five reported
    // "failures" came from.
    const picked = stratify(DS.cases, 20);
    assert.equal(picked.length, 20);
    assert.ok(picked.some(c => !(c.claims?.length)), 'a 20-case sample reached no negative case');
  });

  test('every category is represented before any is doubled', () => {
    const cats = new Set(DS.cases.map(c => c.cat));
    const picked = stratify(DS.cases, cats.size);
    assert.equal(new Set(picked.map(c => c.cat)).size, cats.size);
  });

  test('it is deterministic — the same limit picks the same cases', () => {
    // Two runs at the same budget must be comparable to each other. An RNG
    // here would make every partial run its own incomparable population.
    const a = stratify(DS.cases, 37).map(c => c.id);
    const b = stratify(DS.cases, 37).map(c => c.id);
    assert.deepEqual(a, b);
  });

  test('a limit at or above the dataset returns everything, in order', () => {
    assert.deepEqual(stratify(DS.cases, DS.cases.length), DS.cases);
    assert.deepEqual(stratify(DS.cases, 10_000), DS.cases);
  });
});

// ── 3 & 4. Zero denominators and comparability ───────────────────────────────

const partial = {
  detection_recall: 0.9, false_positives: 0, negatives: 0,
  positives: 20, labelled_claims: 20, n_cases_negation: 0, detection_negation: 0,
};
const full = {
  detection_recall: 0.9, false_positives: 1, negatives: 40,
  positives: 160, labelled_claims: 160, n_cases_negation: 20, detection_negation: 0.96,
};

describe('a metric with no cases is unmeasured, not zero', () => {
  test('negation reports null when no negation case was sent', () => {
    const v = evaluatePromotion(partial, {}, { comparable: false });
    const neg = v.checks.find(c => c.name === 'negation');
    assert.equal(neg.got, null);
    assert.equal(neg.measured, false);
  });

  test('precision reports null when there were no negatives to be wrong about', () => {
    // The old formula divided by `Math.max(1, negatives)`, so zero negatives
    // silently produced a perfect 100% — a PASS nobody had earned.
    const v = evaluatePromotion(partial, {}, { comparable: false });
    assert.equal(v.checks.find(c => c.name === 'precision').got, null);
  });

  test('an unmeasured check still blocks promotion', () => {
    // Not measured is not passed. The point is to stop it looking like a
    // catastrophic score, not to wave it through.
    assert.equal(evaluatePromotion(partial, {}, { comparable: false }).promote, false);
  });

  test('a measured negation score is graded normally', () => {
    const v = evaluatePromotion(full, {}, { comparable: true });
    const neg = v.checks.find(c => c.name === 'negation');
    assert.equal(neg.measured, true);
    assert.ok(neg.pass);
  });
});

describe('a partial run is never compared to a full-set baseline', () => {
  test('regressions are not computed for a partial run', () => {
    // The first run listed `silence_on_negatives 0.9 → 0` as a regression,
    // comparing 200 cases with 40 negatives against 20 cases with none. Two
    // populations, not a change.
    const v = evaluatePromotion(partial, { silence_on_negatives: 0.9, subject_recall: 0.55 }, { comparable: false });
    assert.deepEqual(v.regressions, []);
    assert.equal(v.comparable, false);
  });

  test('a full run still catches a real regression', () => {
    const v = evaluatePromotion(full, { subject_recall: 0.9 }, { comparable: true });
    assert.ok(v.regressions.some(r => r.metric === 'subject_recall'));
    assert.equal(v.promote, false);
  });
});

// ── 5. Discard attribution ───────────────────────────────────────────────────

describe('discards name their reason, not just a stage number', () => {
  test('the pipeline keys byGate with the reason attached', () => {
    // The first run reported `discardedByGate: {"2": 2}`. Gate 2 covers both
    // `object-missing` (the model omitted a field) and `object-not-in-quote`
    // (it invented content) — opposite defects in one bucket, and the bucket
    // was the only record kept.
    const src = readFileSync(path.join(HERE, '../understanding/pipeline.js'), 'utf8');
    assert.match(src, /byGate\[key\]/, 'pipeline no longer uses a composite discard key');
    assert.match(src, /\$\{v\.gate \?\? '\?'\}:\$\{v\.reason \?\? 'unknown'\}/,
      'the discard key must carry both the gate and the reason');
  });

  test('the suite publishes per-category case counts', () => {
    // The denominators the 0/0 check above depends on. Without these the
    // promotion gate cannot tell a scored zero from an unasked question.
    const m = suite.metrics(DS.cases.map(c => suite.score(c, { facts: [], surfaces: [] })));
    assert.ok(Number.isInteger(m.n_cases_negation), 'n_cases_negation is missing');
    assert.ok(m.n_cases_negation > 0);
  });
});

// ── Run-to-run noise ─────────────────────────────────────────────────────────

describe('the provider is not reproducible, and the harness measures it', () => {
  test('spread reports mean, extremes and range', () => {
    const sp = spread([0.52, 0.68, 0.60]);
    assert.equal(sp.n, 3);
    assert.equal(sp.min, 0.52);
    assert.equal(sp.max, 0.68);
    assert.ok(Math.abs(sp.range - 0.16) < 1e-9);
  });

  test('a drop smaller than the noise is NOT a regression', () => {
    // The case that produced this. Run 2 blocked promotion on
    // `fidelity_accuracy 64.7% → 64.1%` — 0.6 points — while two identical
    // runs of the same pinned model at temperature 0 differed by 16 points on
    // `detection_modality`. Only the eval adapter's surface casing changed
    // between those runs, and `surfaces` feeds `subjectHits` alone, so nothing
    // else moving was attributable to the change.
    assert.equal(isRealRegression(0.647, 0.641, 0.16), false);
  });

  test('a drop larger than the noise still is one', () => {
    assert.equal(isRealRegression(0.90, 0.70, 0.02), true);
  });

  test('with no noise estimate the answer is null, not false', () => {
    // Unmeasured must not read as cleared. A single pass cannot support the
    // claim either way, and returning false would silently wave drops through.
    assert.equal(isRealRegression(0.647, 0.641, null), null);
  });

  test('the noise floor removes a phantom regression from the verdict', () => {
    const metrics = {
      detection_recall: 0.838, fidelity_accuracy: 0.641, positives: 160,
      negatives: 40, n_cases_negation: 20, detection_negation: 0.85, false_positives: 1,
    };
    const noisy = evaluatePromotion(metrics, { fidelity_accuracy: 0.647 },
      { comparable: true, noise: { fidelity_accuracy: { range: 0.16 } } });
    assert.deepEqual(noisy.regressions, []);
  });

  test('an unverified drop still blocks, and is labelled unverified', () => {
    const metrics = {
      detection_recall: 0.838, fidelity_accuracy: 0.641, positives: 160,
      negatives: 40, n_cases_negation: 20, detection_negation: 0.96, false_positives: 1,
    };
    const v = evaluatePromotion(metrics, { fidelity_accuracy: 0.647 }, { comparable: true });
    assert.equal(v.regressions.length, 1);
    assert.equal(v.regressions[0].verified, false);
    assert.equal(v.promote, false, 'unverified is not cleared');
  });
});

// ── A dead transport is not a measurement ────────────────────────────────────

describe('a pass the provider did not answer is not data', () => {
  /**
   * WHAT HAPPENED. `--repeat 3` over 200 cases is 525 calls, and all four Groq
   * free keys rate-limited during pass 2 (cooldowns 186s–657s). Pass 2 finished
   * blind; pass 3 made ZERO successful calls. The harness reported the LAST
   * pass unconditionally, so it published pass 3:
   *
   *   detection_recall      0.0%      silence_on_negatives  100.0%
   *   subject_recall        0.0%      overall_strict         20.0%
   *
   * Empty extractions score 0% detection and perfect silence, which is exactly
   * the shape `e6-shadow.mjs`'s own header calls "indistinguishable from a
   * catastrophically bad extractor". `e6Stats.errors` was being counted the
   * whole time and never read.
   */
  test('the error-rate ceiling is tight enough to catch a dead pass', () => {
    // 175 errors over 200 cases is 87.5%; a couple of stragglers is ~1%.
    assert.ok(MAX_PASS_ERROR_RATE > 0 && MAX_PASS_ERROR_RATE <= 0.05,
      `${MAX_PASS_ERROR_RATE} is not a ceiling that separates flaky from gone`);
    assert.ok(175 / 200 > MAX_PASS_ERROR_RATE, 'the observed dead pass must be rejected');
    assert.ok(2 / 200 <= MAX_PASS_ERROR_RATE, 'two stragglers must not reject a pass');
  });

  test('the abort trips well before a whole pass is wasted', () => {
    assert.ok(ABORT_AFTER_CONSECUTIVE_ERRORS >= 5, 'too twitchy — one flaky key would abort');
    assert.ok(ABORT_AFTER_CONSECUTIVE_ERRORS <= 25, 'too slow — pass 3 burned 200 dead cases');
  });

  test('the script refuses to publish when no pass was valid', () => {
    // The SELECTION half of this used to be two source-text greps pinning the
    // exact expression `good[good.length - 1]`. Extracting that logic into
    // `pickReportedPass` broke them — while the behaviour they described was
    // unchanged and is now asserted directly, in the block at the end of this
    // file. A test that fails on a refactor and passes on a defect is measuring
    // the source, not the system.
    //
    // What stays here is the part that genuinely cannot be reached from a unit:
    // the script must EXIT rather than print zeros, and that lives in main().
    const src = readFileSync(path.join(HERE, '../../../scripts/e6-shadow.mjs'), 'utf8');
    assert.match(src, /NOTHING WAS MEASURED/,
      'a run with no valid pass must exit non-zero, not print zeros as results');
    assert.equal(pickReportedPass([{ valid: false }, { valid: false }]), null,
      'the reported pass must come from the VALID set, not from all passes');
  });

  test('noise is computed over valid passes only', () => {
    const src = readFileSync(path.join(HERE, '../../../scripts/e6-shadow.mjs'), 'utf8');
    assert.match(src, /spread\(good\.map\(p => p\.metrics\[k\]\)\)/,
      'a dead pass in the spread makes every range meaningless');
  });

  test('counts are not rendered as percentages', () => {
    // The first noise table led with `false_positives 0.0% – 300.0%` — three
    // false positives printed as 300%, sorted to the top because it looked
    // like the largest range in the run.
    const src = readFileSync(path.join(HERE, '../../../scripts/e6-shadow.mjs'), 'utf8');
    assert.match(src, /IS_COUNT/);
    assert.match(src, /IS_COUNT\.test\(k\)/, 'the noise table must branch on count-vs-rate');
  });
});

// ── A rate limit is a pause, not a death ─────────────────────────────────────

describe('the harness waits out a cooldown instead of scoring silence', () => {
  /**
   * The abort added for the dead-transport case fired on the WRONG cause. A
   * `--repeat 3 --limit 60` run stopped all three passes after 33 calls while
   * the provider was reporting cooldowns of 106s, 151s, 580s and 830s — every
   * one a known, finite wait. Correct verdict, wrong reason, and a run lost to
   * a pause it could have slept through.
   */
  test('the provider exposes when a key frees, so the wait is knowable', async () => {
    const { msUntilAnyKeyFree } = await import('../../providers/groq.js');
    assert.equal(typeof msUntilAnyKeyFree, 'function');
    // No keys configured in this environment — null, not a crash and not 0,
    // because "none exist" and "one is free now" are different answers.
    assert.equal(msUntilAnyKeyFree(), null);
  });

  test('the harness consults it before counting a transport error', () => {
    const src = readFileSync(path.join(HERE, '../../../scripts/e6-shadow.mjs'), 'utf8');
    assert.match(src, /msUntilAnyKeyFree\(\)/);
    assert.match(src, /await sleep\(wait \+ 1000\)/, 'a waitable stall must sleep and retry the same case');
  });

  test('the stall ceiling separates a per-minute limit from a daily one', () => {
    // Observed cooldowns ran to 830s. A daily quota reports far longer, and
    // sleeping through that is worse than stopping and saying so.
    assert.ok(MAX_STALL_WAIT_MS > 830_000, 'the longest observed cooldown must be waitable');
    assert.ok(MAX_STALL_WAIT_MS <= 30 * 60 * 1000, 'sleeping this long hides a daily-quota problem');
  });

  test('calls are paced by default', () => {
    // 175 back-to-back calls cooled every key. A default of 0 would put the
    // burden on remembering a flag.
    const src = readFileSync(path.join(HERE, '../../../scripts/e6-shadow.mjs'), 'utf8');
    const m = src.match(/flag\('--pace', (\d+)\)/);
    assert.ok(m, '--pace is not wired');
    assert.ok(Number(m[1]) > 0, 'pacing must be on by default');
  });

  test('the failure advice does not recommend the command that just failed', () => {
    // It previously printed "Use --repeat 3 --limit 60" — verbatim what the
    // user had just run and watched fail.
    const src = readFileSync(path.join(HERE, '../../../scripts/e6-shadow.mjs'), 'utf8');
    const advice = src.slice(src.indexOf('NOTHING WAS MEASURED'), src.indexOf('NOTHING WAS MEASURED') + 700);
    assert.ok(!/--limit 60/.test(advice), 'still recommending the failed command');
    assert.match(advice, /DAILY quota/, 'the advice must name the actual constraint');
  });
});

// ── A score you cannot explain ───────────────────────────────────────────────

describe('the run records what happened per case, not just the totals', () => {
  /**
   * `detection_negation` read exactly 85.0% on both valid full runs — 17 of 20,
   * the same three cases missing, while every other metric moved by up to 16
   * points. Two explanations were checkable offline and both came back
   * negative:
   *
   *   · prompt rule 2 covers negation explicitly — "Never drop a negation.
   *     'Dev is not on the team' is polarity 'negated', not an omission."
   *   · every labelled negation predicate IS in the registry (31 registered,
   *     zero unregistered across all seven categories)
   *
   * What remained was whether the model returned [] or a gate rejected the
   * claim — and `discardedByGate` is summed across all 200 cases, so it cannot
   * attribute a discard to a case. One number, two suspects, no way to separate
   * them. Three sessions of "negation is 85%" with no path to why.
   */
  test('per-case records are captured and written to the JSON', () => {
    const src = readFileSync(path.join(HERE, '../../../scripts/e6-shadow.mjs'), 'utf8');
    assert.match(src, /perCase\.push\(\{/, 'no per-case record is captured');
    assert.match(src, /perCase: reported\.perCase/, 'the record never reaches the JSON');
  });

  test('each record can separate "model returned []" from "a gate dropped it"', () => {
    // The whole point. Without both fields the two causes stay indistinguishable.
    const src = readFileSync(path.join(HERE, '../../../scripts/e6-shadow.mjs'), 'utf8');
    assert.match(src, /e6Emitted: e6\.facts\.length/);
    assert.match(src, /e6DiscardedBy: e6\.stats\.byGate/);
  });

  test('records come from the REPORTED pass, not an arbitrary one', () => {
    // Same rule the metrics follow. Records from a discarded pass would
    // describe a run whose numbers were thrown away.
    const src = readFileSync(path.join(HERE, '../../../scripts/e6-shadow.mjs'), 'utf8');
    assert.match(src, /perCase: reported\.perCase/);
    assert.ok(!/perCase: passes\[/.test(src), 'records must not be taken from all passes');
  });

  test('the console names the cases that emitted nothing', () => {
    const src = readFileSync(path.join(HERE, '../../../scripts/e6-shadow.mjs'), 'utf8');
    assert.match(src, /EMITTED NOTHING/);
    assert.match(src, /model returned \[\] — no gate involved/,
      'a miss with no gate entry must say so explicitly rather than showing an empty list');
  });
});

// ── Which pass gets published ────────────────────────────────────────────────

/**
 * 🔴 THIS WAS COVERED BY A GREP, AND A GREP IS NOT A TEST.
 *
 * The existing assertions for this machinery are `assert.match(src, /perCase\.push\(\{/)`
 * — they prove a STRING is present in the script. They pass whether the record
 * is correct, whether the right pass is chosen, or whether the whole thing is
 * dead code. The behaviour they are standing in for is the one that already
 * failed once in production: an earlier version reported
 * `passes[passes.length - 1]` unconditionally, landed on a pass in which the
 * provider had answered nothing, and published 0.0% detection as a measurement.
 *
 * `e6-noise.json` in this repository is that failure, preserved: 218 transport
 * errors across 525 calls, every metric zero, and no field in the file marking
 * it as invalid. Anyone reading it later — or any script consuming it — sees a
 * complete-looking record saying E6 detects nothing.
 *
 * BITE, MEASURED (revert the named property → count failures):
 *   pickReportedPass filters to valid passes  → 3 fail
 *   an all-invalid run returns null           → 2 fail
 *   the error-rate threshold is enforced      → 2 fail
 */
describe('only a pass the provider actually answered may be published', () => {
  const pass = (index, passErrors, aborted = false) => {
    const p = { index, passErrors, aborted, metrics: { detection_negation: 0.85 } };
    return { ...p, ...passIsValid(p, 200) };
  };

  test('a clean pass is valid', () => {
    assert.equal(pass(1, 0).valid, true);
    assert.equal(pass(1, 4).valid, true, '2% of 200 is the threshold, not over it');
  });

  test('THE e6-noise.json CASE: 41% errors is not a measurement', () => {
    // 218 errors over 525 calls across three passes. Whatever the per-pass
    // split, no pass at that rate is data.
    const p = pass(3, 73);
    assert.equal(p.valid, false);
    assert.ok(p.errorRate > MAX_PASS_ERROR_RATE);
  });

  test('a single error over the threshold invalidates the pass', () => {
    assert.equal(pass(1, 5).valid, false, '5/200 = 2.5%, over the 2% bar');
  });

  test('an ABORTED pass is invalid however few errors it recorded', () => {
    // Aborting after consecutive errors means the run stopped early, so a low
    // error COUNT is an artifact of not having tried the rest.
    assert.equal(pass(1, 1, true).valid, false);
  });

  test('THE FIX: the last VALID pass is reported, not the last pass', () => {
    // The exact defect. Pass 3 is the most recent and is garbage; pass 2 is the
    // most recent thing anybody measured.
    const passes = [pass(1, 0), pass(2, 0), pass(3, 180)];
    assert.equal(pickReportedPass(passes).index, 2);
  });

  test('a valid pass BEFORE an invalid one is still reachable', () => {
    assert.equal(pickReportedPass([pass(1, 0), pass(2, 200), pass(3, 200)]).index, 1);
  });

  test('all passes invalid returns NULL — not a plausible empty pass', () => {
    // Returning an empty metrics object here is how zeros become "results".
    // Null forces the caller to handle "nothing was measured" explicitly.
    assert.equal(pickReportedPass([pass(1, 200), pass(2, 200)]), null);
    assert.equal(pickReportedPass([]), null);
  });

  test('the reported pass is a REAL pass, never an average', () => {
    // Averaging two passes invents a run that never happened and cannot be
    // reproduced from any single command — which is the property that makes a
    // published number worth arguing about.
    const passes = [pass(1, 0), pass(2, 0)];
    passes[0].metrics = { detection_negation: 0.80 };
    passes[1].metrics = { detection_negation: 0.90 };
    assert.equal(pickReportedPass(passes).metrics.detection_negation, 0.90,
      'the reported value is not one of the passes — it was averaged');
  });
});

// ── The script can read the keys it demands ──────────────────────────────────

describe('e6-shadow loads the root .env, like the app does', () => {
  const SCRIPT = path.join(HERE, '../../../scripts/e6-shadow.mjs');

  test('it loads .env BEFORE importing any provider', () => {
    // A GREP, AND DELIBERATELY SO. This is an import-time side effect in a
    // script whose module body runs main(); there is no unit to call. The same
    // reasoning keeps `NOTHING WAS MEASURED` as a source assertion above —
    // grep is the right tool when the behaviour cannot be reached any other
    // way, and the wrong tool when it can, which is why pass selection moved
    // out of source assertions and into the block below.
    //
    // WHAT THIS GUARDS: the script's own error message says "this script needs
    // the same key the app uses". The app is index.js, which calls
    // dotenv.config(). The script called nothing, so a correctly configured
    // machine reported no keys and sent the operator hunting for a key that
    // was already on disk.
    const src = readFileSync(SCRIPT, 'utf8');
    const envAt = src.indexOf("'dotenv'");
    const providerAt = src.indexOf("from '../src/providers/");
    assert.ok(envAt > 0, 'the script no longer loads .env — the key hunt returns');
    assert.ok(envAt < providerAt, 'providers are imported before .env is loaded');
  });

  test('a shell export still wins over the file', () => {
    // dotenv's documented behaviour, pinned because the whole point is to match
    // index.js: CI passes real environment variables and must not be
    // overridden by a stale .env sitting in the checkout.
    const src = readFileSync(SCRIPT, 'utf8');
    assert.ok(!/override\s*:\s*true/.test(src), 'the file would override a shell export');
  });

  test('an absent .env is silent, not a warning', () => {
    // Passing keys as real environment variables is a normal way to run this.
    const src = readFileSync(SCRIPT, 'utf8');
    assert.match(src, /existsSync\(envPath\)/, 'a missing .env must not throw');
  });
});

// ── A case the transport never answered ──────────────────────────────────────

/**
 * 🔴 THE RUN-LEVEL GUARD DID NOT REACH THE CASE LEVEL.
 *
 * This script already refuses a run with no transport, in its own words:
 * "a run with no transport emits no claims and would score 0.0% detection,
 * which is indistinguishable from a catastrophically bad extractor."
 *
 * The same sentence is true of ONE case, and the scorer did not know it.
 * `suite.score(c, { facts: e6.facts })` ran whether or not the call errored —
 * and `e6.facts` is empty because nothing was asked, which grades identically
 * to a wrong answer.
 *
 * It bit on the first three-pass run: all four transport errors landed in
 * pass 3, `pickReportedPass` takes the last VALID pass, and 4/200 sits exactly
 * on the 2% validity bar — so the published numbers came from the only pass
 * with errors in it. On the 20-case negation category one unanswered case is
 * five points, and negation reported 70% against 85% in both clean passes.
 */
describe('an unanswered case is unmeasured, not a miss', () => {
  test('the scorer is only reached for cases the transport answered', () => {
    const src = readFileSync(path.join(HERE, '../../../scripts/e6-shadow.mjs'), 'utf8');
    // Import-time control flow inside main(); no unit to call, so the guard is
    // pinned at the source — the same justification as `NOTHING WAS MEASURED`.
    assert.match(src, /if \(caseErrored\) unmeasured\.push/,
      'errored cases are no longer separated from scored ones');
    assert.match(src, /else scoredE6\.push\(sc\)/,
      'an errored case is being pushed into the scored set');
  });

  test('the EMITTED NOTHING diagnosis excludes transport errors', () => {
    // Listing a timeout under "emitted nothing" sends the reader to the prompt
    // to debug a network problem.
    const src = readFileSync(path.join(HERE, '../../../scripts/e6-shadow.mjs'), 'utf8');
    assert.match(src, /e6Emitted === 0 && !r\.e6Errors/);
  });

  test('unmeasured cases are REPORTED, not quietly dropped', () => {
    // Shrinking a denominator without saying so is how 196 cases get read as
    // 200. G5: the exclusion has to be visible in the output and the JSON.
    const src = readFileSync(path.join(HERE, '../../../scripts/e6-shadow.mjs'), 'utf8');
    assert.match(src, /UNMEASURED —/, 'the exclusion is invisible in the console output');
    assert.match(src, /unmeasured: reported\.unmeasured/, 'the exclusion never reaches the JSON');
  });

  test('a 20-case category cannot support a 95% gate at this noise level', () => {
    // Not a code assertion — an arithmetic one, pinned because it decides
    // whether the negation gate is measurable at all. 95% of 20 is 19/20, and
    // the observed run-to-run range on that category was 70%–85%, or 14/20 to
    // 17/20. Three cases of spread on a bar that allows one miss.
    const NEGATION_CASES = 20;
    const gate = PROMOTION_GATE.negation ?? 0.95;
    const casesAllowedToMiss = NEGATION_CASES - Math.ceil(gate * NEGATION_CASES);
    const observedSpreadInCases = Math.round(0.15 * NEGATION_CASES);
    assert.equal(casesAllowedToMiss, 1);
    assert.ok(observedSpreadInCases > casesAllowedToMiss,
      'noise now fits inside the gate — re-measure before trusting this comment');
  });
});
