/**
 * AQUA Eval — the contradiction baseline
 * Blueprint: the eval FINDING-1 said had to exist before any fix
 *
 * FINDING-1 could show the detector over-fires. It could not show whether a
 * fix removed the false positives without removing the true ones — so nothing
 * was fixed. This suite is what makes that answerable.
 *
 * It turned out the detector is worse than FINDING-1 could see: it also MISSES
 * 9 of 15 genuine contradictions. Over-firing and under-detecting at once.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSuite } from '../core/runner.mjs';
import suite from '../suites/contradiction-core.suite.mjs';
import { _conflictKindForTests as conflictKind } from '../../src/reasoning/relationshipEngine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(readFileSync(path.join(HERE, '../baselines/contradiction-core.v1.json'), 'utf8'));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/contradiction-core.v1.json'), 'utf8'));
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── The seam is real ─────────────────────────────────────────────────────────

describe('contradiction eval — it scores the SHIPPED predicate', () => {
  test('the eval calls the engine, not a copy of its rule', () => {
    // A duplicated rule in the harness would drift the first time either side
    // changed, and the baseline would then measure a detector nobody ships.
    // FINDING-1 exists because this predicate over-fires; a scorer aimed at a
    // copy of it would be worthless.
    //
    // Anchored on REAL dataset cases rather than invented ones. My first
    // version used a hand-written pair that returned null — because it had
    // only four overlapping words and the rule needs more. The seam was fine;
    // the example was wrong, which is exactly the kind of thing an invented
    // fixture gets to be.
    assert.equal(typeof conflictKind, 'function');

    const fires = DS.cases.find(c => c.cat === 'genuine' && conflictKind(c.a, c.b));
    assert.ok(fires, 'the predicate fires on nothing at all — the seam is miswired');

    const silent = DS.cases.find(c => c.cat === 'unrelated');
    assert.equal(conflictKind(silent.a, silent.b), null,
      'the predicate fires on an unrelated pair — the seam is returning a constant');
  });
});

// ── The dataset ──────────────────────────────────────────────────────────────

describe('contradiction eval — the dataset', () => {
  test('it is DELIBERATELY unbalanced toward independent pairs', () => {
    // The measured failure is over-firing, so the set is weighted to expose
    // it. That is also why precision and recall are reported separately: a
    // single accuracy figure over an unbalanced set would flatter a detector
    // that says "contradiction" to everything.
    const genuine = DS.cases.filter(c => c.label === 'contradiction').length;
    const independent = DS.cases.filter(c => c.label === 'independent').length;
    assert.ok(independent > genuine * 2, `${independent} independent vs ${genuine} genuine`);
  });

  test('the per-item-table class is present and large — it is the failure', () => {
    const rows = DS.cases.filter(c => c.cat === 'per-item-table');
    assert.ok(rows.length >= 20);
    assert.ok(rows.every(c => c.label === 'independent'));
  });

  test('every case says WHY it is labelled that way', () => {
    // A relevance judgment with no reason cannot be argued with, and this
    // dataset exists precisely to be argued with.
    for (const c of DS.cases) assert.ok(c.why && c.why.length > 8, c.id);
  });

  test('restatements and temporal sequences are labelled independent', () => {
    // "Runway is fourteen months" / "Runway is 14 months" is ONE fact twice —
    // corroboration, not conflict. "Worked at Intercom until 2024" / "at Nummo
    // since 2025" are both true. Getting these wrong would be a different bug
    // wearing the same clothes.
    for (const cat of ['restatement', 'temporal-sequence']) {
      const rows = DS.cases.filter(c => c.cat === cat);
      assert.ok(rows.length > 0, `no ${cat} cases`);
      assert.ok(rows.every(c => c.label === 'independent'));
    }
  });

  test('the limitations are stated, including what a PAIR cannot express', () => {
    const text = DS.limitations.join(' ');
    assert.match(text, /SYNTHETIC/);
    assert.match(text, /cross-FILE/, 'the dataset does not admit that it skips the provenance gate');
    assert.match(text, /surfacing policy is a separate decision/);
  });
});

// ── The baseline ─────────────────────────────────────────────────────────────

describe('contradiction eval — the baseline reproduces', () => {
  test('every case executes', async () => {
    const { result } = await runSuite(suite);
    assert.equal(result.coverage.total, DS.cases.length);
    assert.equal(result.coverage.complete, true);
  });

  test('precision and recall match what is committed', async () => {
    const { result } = await runSuite(suite);
    for (const key of ['precision', 'recall', 'f1', 'false_fire_per_item_table']) {
      assert.ok(near(result.metrics[key], BASELINE.metrics[key]),
        `${key} moved: committed ${BASELINE.metrics[key]}, measured ${result.metrics[key]}`);
    }
  });

  test('the baseline records the conditions that produced it', () => {
    assert.ok(BASELINE.suiteFingerprint);
    assert.equal(BASELINE.coverage.complete, true);
    assert.match(BASELINE.note, /BOTH precision and recall/);
  });
});

// ── The findings, pinned ─────────────────────────────────────────────────────

describe('contradiction eval — what the numbers say', () => {
  const m = BASELINE.metrics;

  test('CLOSED: precision is now perfect on this set', () => {
    // Was 21.4% with 22 false positives against 6 true. The subject gate
    // removed all 22 without costing a true one.
    assert.equal(m.precision, 1);
    assert.equal(m.false_positives, 0);
  });

  test('CLOSED: it no longer fires on per-item tables at all', () => {
    // The exact shape FINDING-1 measured at 73,500 edges. Now zero — and
    // confirmed independently on that same 300/600-fact graph, which is data
    // the fix was never tuned against.
    assert.equal(m.false_fire_per_item_table, 0);
  });

  test('IMPROVED TWICE, still incomplete: recall 40% → 73.3% → 93.3%', () => {
    // FINDING-1 could not see this half. The predicate only compares DIGITS,
    // so it is blind to:
    //   spelled numbers      "fourteen months" vs "six months"
    //   categorical conflict "confirmed" vs "cancelled"
    //   entity conflict      "reports to Priya" vs "reports to Karan"
    //
    // Over-firing and under-detecting at once. A fix must move BOTH.
    // Spelled numbers, categorical conflict and relation tails are now read.
    // Four genuine contradictions are still missed — recorded rather than
    // rounded up to "fixed".
    // FIX-2: the qualifier gate was suppressing spelled numbers and month
    // names before they could be compared. "This rule bites nothing" turned
    // out to mean "something upstream is eating its input".
    assert.ok(m.recall > 0.9, `recall ${m.recall}`);
    assert.ok(m.recall < 1, 'recall is perfect — update this test and the note');
    assert.equal(m.false_negatives, 1);
  });

  test('the categories it gets RIGHT are recorded too', () => {
    // Restatements and unrelated pairs produce zero false fires. A fix must
    // not regress them, and saying only what is broken would make the detector
    // sound worthless rather than misaimed.
    assert.equal(m.false_fire_restatement, 0);
    assert.equal(m.false_fire_unrelated, 0);
  });

  test('precision and recall are NEVER averaged into one number', async () => {
    // Buying precision by dropping recall is not a fix, it is a different bug.
    // f1 is reported, but the components are what a fix has to move together.
    const { result } = await runSuite(suite);
    assert.ok('precision' in result.metrics);
    assert.ok('recall' in result.metrics);
    assert.ok(!('accuracy' in result.metrics),
      'a single accuracy figure over an unbalanced set flatters an over-firing detector');
  });
});

// ── The scorer is fair ───────────────────────────────────────────────────────

describe('contradiction eval — the scorer is not rigged', () => {
  test('a PERFECT detector scores 1.0 on both metrics', () => {
    // So the published numbers come from the engine, not the grader.
    const scored = DS.cases.map(c => suite.score(c, { fired: c.label === 'contradiction', kind: null }));
    const m = suite.metrics(scored);
    assert.equal(m.precision, 1);
    assert.equal(m.recall, 1);
    assert.equal(m.false_positives, 0);
  });

  test('a detector that fires on EVERYTHING gets recall 1 and terrible precision', () => {
    // The behaviour under investigation, scored explicitly — this is what a
    // single accuracy number would have hidden.
    const scored = DS.cases.map(c => suite.score(c, { fired: true, kind: 'numeric' }));
    const m = suite.metrics(scored);
    assert.equal(m.recall, 1);
    assert.ok(m.precision < 0.35);
  });

  test('a detector that fires on NOTHING gets precision 0, not 1', () => {
    // Guarding the divide-by-zero that would make silence look perfect.
    const scored = DS.cases.map(c => suite.score(c, { fired: false, kind: null }));
    const m = suite.metrics(scored);
    assert.equal(m.precision, 0);
    assert.equal(m.recall, 0);
    assert.equal(m.f1, 0);
  });
});
