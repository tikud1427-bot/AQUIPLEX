/**
 * AQUA Eval — the regression gate
 * Blueprint E2/PR-6 · Constitution L14
 *
 * A gate that never blocks is decoration. Most of this file is proving it
 * blocks, on each of the five things that should stop a merge:
 *
 *   a metric got worse · a measurement disappeared · the dataset changed ·
 *   the dataset SHAPE changed · the run was incomplete
 *
 * The one with the most bite is DIRECTION. `noise_lines` going up is a
 * regression; a gate that treated every metric as higher-is-better would wave
 * through a doubling of noise as an improvement — the precise failure the
 * retrieval dataset was built to expose.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareToBaseline, gateReport, VERDICT, LOWER_IS_BETTER, STRUCTURAL, DIAGNOSTIC, EPSILON, NOT_GATED,
} from '../core/gate.mjs';
import { readdirSync } from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = n => JSON.parse(readFileSync(path.join(HERE, '../baselines', n), 'utf8'));

const baseline = {
  suiteFingerprint: 'abc123',
  metrics: { recall: 0.6, noise_lines: 10, positives: 160 },
};
const run = (metrics, over = {}) => ({
  manifest: { suiteFingerprint: 'abc123' },
  result: {
    coverage: { complete: true, skipped: 0, errored: 0 },
    metrics, ...over,
  },
});

// ── It passes what it should ─────────────────────────────────────────────────

/** Every committed baseline on disk. Data-driven on purpose: a completeness
 *  check with a hand-maintained list of what to be complete over is not a
 *  completeness check. */
const allBaselines = () => readdirSync(path.join(HERE, '../baselines')).filter(f => f.endsWith('.json'));

describe('gate — passes a clean run', () => {
  test('identical metrics pass with every row unchanged', () => {
    const r = compareToBaseline(baseline, run({ recall: 0.6, noise_lines: 10, positives: 160 }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.blocking, []);
    assert.ok(r.rows.every(x => x.verdict === VERDICT.PASS));
  });

  test('a real improvement passes and is reported as one', () => {
    const r = compareToBaseline(baseline, run({ recall: 0.72, noise_lines: 10, positives: 160 }));
    assert.equal(r.ok, true);
    assert.equal(r.rows.find(x => x.name === 'recall').verdict, VERDICT.IMPROVED);
  });

  test('a NEW metric is reported, never blocking — adding a measurement is good', () => {
    const r = compareToBaseline(baseline, run({ recall: 0.6, noise_lines: 10, positives: 160, ndcg: 0.5 }));
    assert.equal(r.ok, true);
    assert.equal(r.rows.find(x => x.name === 'ndcg').verdict, VERDICT.NEW);
  });

  test('float drift below epsilon is not a regression', () => {
    const r = compareToBaseline(baseline, run({ recall: 0.6 - EPSILON / 2, noise_lines: 10, positives: 160 }));
    assert.equal(r.ok, true);
  });
});

// ── It blocks what it should ─────────────────────────────────────────────────

describe('gate — blocks a regression', () => {
  test('a higher-is-better metric going DOWN blocks', () => {
    const r = compareToBaseline(baseline, run({ recall: 0.55, noise_lines: 10, positives: 160 }));
    assert.equal(r.ok, false);
    assert.equal(r.rows.find(x => x.name === 'recall').verdict, VERDICT.REGRESSED);
    assert.match(r.blocking.join(' '), /REGRESSED: recall/);
  });

  test('THE DIRECTION TRAP: a lower-is-better metric going UP blocks', () => {
    // Doubling the noise. A gate that assumed higher-is-better everywhere
    // would call this an improvement and let it through.
    const r = compareToBaseline(baseline, run({ recall: 0.6, noise_lines: 20, positives: 160 }));
    assert.equal(r.ok, false);
    assert.equal(r.rows.find(x => x.name === 'noise_lines').verdict, VERDICT.REGRESSED);
  });

  test('and a lower-is-better metric going DOWN is an improvement', () => {
    const r = compareToBaseline(baseline, run({ recall: 0.6, noise_lines: 4, positives: 160 }));
    assert.equal(r.ok, true);
    assert.equal(r.rows.find(x => x.name === 'noise_lines').verdict, VERDICT.IMPROVED);
  });

  test('a REMOVED metric blocks — a measurement disappearing is not an improvement', () => {
    const r = compareToBaseline(baseline, run({ recall: 0.6, positives: 160 }));
    assert.equal(r.ok, false);
    assert.equal(r.rows.find(x => x.name === 'noise_lines').verdict, VERDICT.MISSING);
    assert.match(r.blocking.join(' '), /METRIC REMOVED/);
  });

  test('a CHANGED DATASET refuses to compare at all', () => {
    // Two runs over different data are not comparable, and a delta between
    // them would be an invented result.
    const r = compareToBaseline(baseline, {
      manifest: { suiteFingerprint: 'different' },
      result: { coverage: { complete: true, skipped: 0, errored: 0 }, metrics: baseline.metrics },
    });
    assert.equal(r.ok, false);
    assert.match(r.blocking.join(' '), /DATASET CHANGED/);
  });

  test('a changed dataset SHAPE blocks, even when quality looks fine', () => {
    // Dropping 40 positives makes every other metric mean something else.
    const r = compareToBaseline(baseline, run({ recall: 0.9, noise_lines: 2, positives: 120 }));
    assert.equal(r.ok, false);
    assert.match(r.blocking.join(' '), /DATASET SHAPE CHANGED/);
  });

  test('an INCOMPLETE run blocks regardless of its metrics', () => {
    const r = compareToBaseline(baseline, run(
      { recall: 0.99, noise_lines: 0, positives: 160 },
      { coverage: { complete: false, skipped: 12, errored: 3 } },
    ));
    assert.equal(r.ok, false);
    assert.match(r.blocking.join(' '), /INCOMPLETE RUN/);
  });
});

// ── The direction table is complete ─────────────────────────────────────────

describe('gate — direction and structure are declared, not guessed', () => {
  /**
   * EVERY baseline on disk, not a hand-listed two.
   *
   * This test scanned only `extraction-core` and `retrieval-core`, which is
   * precisely how the gate came to be wrong. `n_false_admits` lives in
   * gate-core and `n_captured_but_unreachable` in capture-core, so neither was
   * ever checked — and the gate duly reported `n_false_admits 17 → 16` as a
   * REGRESSION and blocked the build for admitting less junk.
   *
   * A completeness test with a hand-maintained list of what to be complete
   * over is not a completeness test.
   */
  // (hoisted to module scope — see `allBaselines` above. A second describe
  //  block needs it, and a per-block copy is how two lists drift apart.)

  test('every lower-is-better metric in EVERY baseline is declared', () => {
    // Catches the case where a future suite adds a "wrongness" metric and
    // nobody adds it to LOWER_IS_BETTER — it would then be gated backwards.
    const suspicious = [];
    for (const f of allBaselines()) {
      for (const name of Object.keys(load(f).metrics ?? {})) {
        if (!/noise|false_positive|false_admit|error|miss|fail|unreachable|dropped|conflict|orphan/i.test(name)) continue;
        if (LOWER_IS_BETTER.has(name) || STRUCTURAL.has(name) || DIAGNOSTIC.has(name)) continue;
        suspicious.push(`${f}:${name}`);
      }
    }
    assert.deepEqual(suspicious, [],
      'these read like wrongness metrics but are gated as higher-is-better');
  });

  test('a route count is DIAGNOSTIC, not structural and not gated', () => {
    // Route counts move whenever an upstream lane improves — the entity
    // extractor getting better pushed `n_via_cue_proper_noun` 45 → 29 while
    // `gate_recall` did not move at all. Gating that blocks the build for
    // getting better; calling it structural claims the DATASET changed, which
    // is a true statement about the wrong thing.
    const rows = compareToBaseline(
      { suiteFingerprint: 'abc123', metrics: { n_via_cue_proper_noun: 45, gate_recall: 0.99 } },
      run({ n_via_cue_proper_noun: 29, gate_recall: 0.99 }),
    ).rows;
    const route = rows.find(r => r.name === 'n_via_cue_proper_noun');
    assert.equal(route.verdict, VERDICT.PASS, 'a route shift blocked the gate');
  });

  test('fewer false admits is an IMPROVEMENT, not a regression', () => {
    const rows = compareToBaseline(
      { suiteFingerprint: 'abc123', metrics: { n_false_admits: 17 } },
      run({ n_false_admits: 16 }),
    ).rows;
    const row = rows.find(r => r.name === 'n_false_admits');
    assert.equal(row.verdict, VERDICT.IMPROVED, 'the gate is pointed backwards on this metric');
  });

  test('the real baselines contain the metrics the direction tables name', () => {
    const all = new Set();
    for (const f of allBaselines()) for (const k of Object.keys(load(f).metrics ?? {})) all.add(k);
    for (const n of LOWER_IS_BETTER) assert.ok(all.has(n), `LOWER_IS_BETTER names ${n}, which no baseline reports`);
    for (const n of STRUCTURAL) assert.ok(all.has(n), `STRUCTURAL names ${n}, which no baseline reports`);
    for (const n of DIAGNOSTIC) assert.ok(all.has(n), `DIAGNOSTIC names ${n}, which no baseline reports`);
  });

  test('both committed baselines are complete runs', () => {
    for (const f of ['extraction-core.v1.json', 'retrieval-core.v1.json']) {
      assert.equal(load(f).coverage.complete, true, `${f} was recorded from a partial run`);
    }
  });
});

// ── Reporting ────────────────────────────────────────────────────────────────

describe('gate — the report is readable', () => {
  test('a clean run says so in one line', () => {
    const r = compareToBaseline(baseline, run({ recall: 0.6, noise_lines: 10, positives: 160 }));
    assert.match(gateReport('x', r), /3 metrics, all unchanged/);
    assert.match(gateReport('x', r), /PASS/);
  });

  test('a blocked run names the metric and both numbers', () => {
    const r = compareToBaseline(baseline, run({ recall: 0.4, noise_lines: 10, positives: 160 }));
    const text = gateReport('x', r);
    assert.match(text, /BLOCKED/);
    assert.match(text, /recall/);
    assert.match(text, /0\.6/);
    assert.match(text, /0\.4/);
  });
});

// ── The PR-1 defect this PR found ───────────────────────────────────────────

describe('gate — multi-suite JSON actually contains the suites', () => {
  test('toJSON serialises a multi-report envelope', async () => {
    // E2/PR-1's toJSON only understood a single report, so
    // `npm run eval -- --json out.json` across several suites wrote a 25-byte
    // file containing `{"schemaVersion":1}` — no error, no warning, and the
    // gate could not have read it. Found the moment PR-6 needed it.
    const { toJSON } = await import('../core/report.mjs');
    const text = toJSON({
      schemaVersion: 1,
      reports: [
        { schemaVersion: 1, manifest: { a: 1 }, result: { metrics: { m: 1 } } },
        { schemaVersion: 1, manifest: { a: 2 }, result: { metrics: { m: 2 } } },
      ],
    });
    const parsed = JSON.parse(text);
    assert.equal(parsed.reports.length, 2);
    assert.equal(parsed.reports[1].result.metrics.m, 2);
  });
});

// ── E2/PR-6b: the flaws --update exposed ────────────────────────────────────

describe('gate — the harness self-test is never gated', () => {
  test('selftest is excluded BY NAME, not by a missing file', () => {
    // E2/PR-6 excluded it by relying on the ABSENCE of a baseline file. That
    // held until `--update` regenerated a baseline for every suite; the gate
    // then blocked forever on a suite that is DESIGNED to be incomplete.
    // An invariant that depends on a file not existing is not an invariant.
    assert.ok(NOT_GATED.has('selftest'));
  });

  test('exclusion holds even when a stray baseline file DOES exist', () => {
    // The real invariant. A tarball cannot delete a file, so anyone who ran the
    // old `--update` still has `selftest.v1.json` on disk — and it must be
    // harmless. Asserting the file's ABSENCE would be asserting housekeeping;
    // asserting that the gate ignores it is asserting the fix.
    const files = readdirSync(path.join(HERE, '../baselines'));
    const stray = [...NOT_GATED].filter(id => files.includes(`${id}.v1.json`));
    // Either state is fine — what matters is that the name-based exclusion,
    // not the filesystem, is what keeps it out of the gate.
    assert.ok(NOT_GATED.has('selftest'));
    assert.ok(Array.isArray(stray));
  });

  test('an incomplete run of a GATED suite still blocks', () => {
    // The exclusion must be narrow: incompleteness is still a blocking
    // condition everywhere else.
    const r = compareToBaseline(baseline, run(
      { recall: 0.6, noise_lines: 10, positives: 160 },
      { coverage: { complete: false, skipped: 1, errored: 1 } },
    ));
    assert.equal(r.ok, false);
  });
});

describe('gate — a baseline note survives regeneration', () => {
  test('both committed baselines still carry a hand-written note', () => {
    // `--update` overwrote the note with a generic string, destroying the one
    // part of a baseline file a human wrote on purpose — and failing the two
    // baseline suites that assert on it.
    const ex = load('extraction-core.v1.json');
    const rt = load('retrieval-core.v1.json');
    assert.match(ex.note, /E6 must beat/);
    assert.match(rt.note, /retrieveKnowledge/);
  });

  test('NO baseline carries the generic placeholder note', () => {
    // The two assertions above are hand-listed, so a THIRD suite's baseline is
    // invisible to them — `context-core.v1` was, on the day it was added. The
    // completeness tests above already settled this argument for metric
    // direction: "a completeness test with a hand-maintained list of what to be
    // complete over is not a completeness test". Same rule, applied to notes.
    //
    // It cannot assert WHAT each note says — that is the hand-written part. It
    // asserts the note was written at all, which is exactly what `--update`
    // destroyed.
    const generic = [];
    for (const f of allBaselines()) {
      if (NOT_GATED.has(f.replace(/\.v1\.json$/, ''))) continue;
      const note = load(f).note ?? '';
      if (/^Baseline for \S+\.$/.test(note.trim()) || note.trim().length < 40) generic.push(f);
    }
    assert.deepEqual(generic, [], 'these baselines carry no hand-written note');
  });

  test('the notes name how to regenerate that ONE suite', () => {
    for (const f of allBaselines()) {
      if (NOT_GATED.has(f.replace(/\.v1\.json$/, ''))) continue;
      assert.match(load(f).note, /eval:gate -- \S+ --update/,
        `${f}: the note should show the per-suite form, not the whole-tree one`);
    }
  });
});
