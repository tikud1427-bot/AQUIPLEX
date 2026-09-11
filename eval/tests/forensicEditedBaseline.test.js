/**
 * AQUA Eval — the forensics `edited_number` baseline
 * Blueprint: the prerequisite FINDING-2 named
 *
 * FINDING-2 declined to apply `differentSubjects` here because a gate
 * validated against the CONTRADICTION evals would be an assumption, not a
 * measurement, when pointed at a FORENSICS rule. This is the measurement.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSuite } from '../core/runner.mjs';
import suite from '../suites/forensic-edited.suite.mjs';
import { _looksEditedForTests, maskNumbers } from '../../src/files/forensicEngine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(readFileSync(path.join(HERE, '../baselines/forensic-edited.v1.json'), 'utf8'));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/forensic-edited.v1.json'), 'utf8'));
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

describe('forensic eval — it scores the SHIPPED rule', () => {
  test('the seam is the engine\'s own predicate, not a copy', () => {
    // A duplicated rule would drift the first time either side changed, and
    // the baseline would measure something nobody ships. Anchored on REAL
    // dataset cases — an invented fixture gets to be wrong, as one was in
    // EVAL-1.
    const genuine = DS.cases.find(c => c.cat === 'genuine');
    assert.equal(_looksEditedForTests(genuine.a, genuine.b), true);
    const shaped = DS.cases.find(c => c.cat === 'different-shape');
    assert.equal(_looksEditedForTests(shaped.a, shaped.b), false);
  });

  test('extracting it changed no behaviour — masking is verbatim', () => {
    assert.equal(maskNumbers('value 1000 on 2026-01-10'), 'value # on #-#-#');
    assert.equal(maskNumbers('no digits here'), 'no digits here');
  });

  test('the FILE gate is deliberately OUTSIDE the predicate', () => {
    // Provenance is policy. FINDING-2's false positives all passed the file
    // gate legitimately — the text is where the error is.
    assert.match(DS.limitations.join(' '), /TEXTUAL predicate only/);
    assert.match(DS.limitations.join(' '), /cross-FILE provenance/);
  });
});

describe('forensic eval — the dataset', () => {
  test('it is weighted toward ORDINARY pairs, because over-firing is the failure', () => {
    const edited = DS.cases.filter(c => c.label === 'edited').length;
    const ordinary = DS.cases.filter(c => c.label === 'ordinary').length;
    assert.ok(ordinary > edited * 2, `${ordinary} ordinary vs ${edited} edited`);
  });

  test('"edited" means the SAME claim with a figure changed', () => {
    // Not merely "these disagree" — that is contradiction-core.v1's question.
    // Conflating them would make this dataset measure the wrong rule.
    assert.match(DS.limitations.join(' '), /SAME claim with one figure changed/);
    for (const c of DS.cases.filter(x => x.label === 'edited')) {
      assert.equal(maskNumbers(c.a), maskNumbers(c.b),
        `${c.id}: labelled edited but the shapes differ — that is a contradiction, not an edit`);
    }
  });

  test('restatements are labelled ordinary — identical is corroboration', () => {
    const rows = DS.cases.filter(c => c.cat === 'restatement');
    assert.ok(rows.length > 0);
    assert.ok(rows.every(c => c.label === 'ordinary' && c.a === c.b));
  });

  test('every case says WHY', () => {
    for (const c of DS.cases) assert.ok(c.why && c.why.length > 8, c.id);
  });

  test('it admits high precision here is necessary, not sufficient', () => {
    assert.match(DS.limitations.join(' '), /rarer and subtler than these fixtures/);
  });
});

describe('forensic eval — the baseline reproduces', () => {
  test('every case executes', async () => {
    const { result } = await runSuite(suite);
    assert.equal(result.coverage.total, DS.cases.length);
    assert.equal(result.coverage.complete, true);
  });

  test('precision and recall match what is committed', async () => {
    const { result } = await runSuite(suite);
    for (const k of ['precision', 'recall', 'f1', 'false_fire_per_item_table']) {
      assert.ok(near(result.metrics[k], BASELINE.metrics[k]),
        `${k} moved: committed ${BASELINE.metrics[k]}, measured ${result.metrics[k]}`);
    }
  });

  test('the note says a fix must HOLD recall, not just raise precision', () => {
    // The trade this rule invites: tighten it, lose a real tampering case, and
    // report an improvement.
    assert.match(BASELINE.note, /HOLDING recall at 1\.0/);
  });
});

describe('forensic eval — what the numbers say', () => {
  const m = BASELINE.metrics;

  // These three tests previously pinned the OPEN defect and said "invert when
  // fixed". FINDING-2 is now fixed, so they are inverted — recording the state
  // that shipped rather than being deleted, because the numbers a fix moved
  // are the numbers a regression would move back.

  test('FIXED: precision is 82% — was 33% on v1, 38% on this dataset', () => {
    // 0.82 rather than the 0.90 the first draft of this test asserted. The
    // difference is e034, a second instance of the index-only hole added
    // DELIBERATELY after the fix was measured. Writing 0.90 would have meant
    // quoting a number produced by a dataset chosen to flatter it.
    assert.ok(m.precision >= 0.8, `precision ${m.precision}`);
    assert.ok(m.n_false_positives < m.n_true_positives,
      'false alerts are now the minority, which for a severity:alert finding is the whole point');
  });

  test('FIXED: the per-item table shape no longer fires at all', () => {
    assert.equal(m.false_fire_per_item_table, 0,
      'all 16 measured false positives are gone');
  });

  test('OPEN: one table shape still fires — a row differing ONLY in its index', () => {
    // e030. Two rows of the same table where the value and date are identical
    // and only the row number moved. On text alone this is indistinguishable
    // from a doctored figure; separating them needs table structure the
    // forensic engine does not have. Recorded rather than hidden.
    assert.equal(m.false_fire_per_item_table_single, 1,
      'INVERT THIS TEST if table structure ever reaches this rule');
  });

  test('DECLARED COST: recall fell to 82% — multi-number doctorings are now missed', () => {
    // The trade this fix makes, stated as a number rather than a caveat.
    // e031 (amount + date) and e032 (percent + amount) both moved two numbers
    // and no longer fire. Accepted deliberately: this rule tells a user their
    // document may be forged, and it was wrong 17 times in 27 before.
    assert.ok(m.recall >= 0.8 && m.recall < 1,
      `recall ${m.recall} — a rise back to 1.0 means the trade was reversed, a fall below 0.8 means the fix cut deeper than measured`);
    assert.equal(m.n_false_negatives, 2, 'exactly the two multi-number cases, no others');
  });

  test('the categories it gets right are recorded too', () => {
    assert.equal(m.false_fire_restatement, 0);
    assert.equal(m.false_fire_different_shape, 0);
  });
});

describe('forensic eval — the scorer is not rigged', () => {
  test('a PERFECT rule scores 1.0 on both', () => {
    const m = suite.metrics(DS.cases.map(c => suite.score(c, { fired: c.label === 'edited' })));
    assert.equal(m.precision, 1);
    assert.equal(m.recall, 1);
  });

  test('a rule that fires on EVERYTHING gets recall 1 and poor precision', () => {
    const m = suite.metrics(DS.cases.map(c => suite.score(c, { fired: true })));
    assert.equal(m.recall, 1);
    assert.ok(m.precision < 0.35);
  });

  test('a rule that fires on NOTHING gets precision 0, not 1', () => {
    // The divide-by-zero that would make total silence look flawless.
    const m = suite.metrics(DS.cases.map(c => suite.score(c, { fired: false })));
    assert.equal(m.precision, 0);
    assert.equal(m.recall, 0);
  });

  test('precision and recall are never averaged into one score', () => {
    const m = suite.metrics(DS.cases.map(c => suite.score(c, { fired: true })));
    assert.ok(!('accuracy' in m),
      'a single accuracy figure over an unbalanced set flatters a rule that flags everything');
  });
});
