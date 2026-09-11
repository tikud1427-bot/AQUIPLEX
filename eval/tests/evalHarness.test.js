/**
 * AQUA Eval — harness behaviour
 * Blueprint E2/PR-1
 *
 * The harness is the thing every later measurement in this project will be
 * quoted from, so it gets tested harder than the things it measures.
 *
 * The load-bearing assertion is `a throw is an ERROR, never a wrong answer`.
 * If that ever collapses, a crashing extractor reads as a quality regression,
 * and someone spends a day debugging the model instead of the harness. It has
 * the most bite in this file for that reason.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { runSuite } from '../core/runner.mjs';
import { validateSuite, SuiteError } from '../core/suiteSchema.mjs';
import { toJSON, toHuman, comparableBody } from '../core/report.mjs';
import { suiteFingerprint } from '../core/manifest.mjs';
import selftest from '../suites/selftest.suite.mjs';

const base = (over = {}) => ({
  id: 'unit', title: 't', about: 'a',
  cases: [{ id: 'x' }],
  run: async () => ({ status: 'ok', actual: 1 }),
  score: () => ({ correct: true }),
  metrics: s => ({ n: s.length }),
  ...over,
});

// ── Suite validation ─────────────────────────────────────────────────────────

describe('eval — suite validation fails loudly and early', () => {
  test('a malformed suite throws BEFORE any case runs', async () => {
    // Without this, a suite missing score() would run 200 cases and report 0% —
    // a typo readable as a catastrophic quality result.
    let ran = 0;
    const suite = base({ score: undefined, run: async () => { ran++; return { status: 'ok', actual: 1 }; } });
    await assert.rejects(() => runSuite(suite), SuiteError);
    assert.equal(ran, 0, 'cases ran despite an invalid suite');
  });

  test('every required field is required', () => {
    for (const missing of ['id', 'title', 'about', 'run', 'score', 'metrics']) {
      assert.throws(() => validateSuite(base({ [missing]: undefined })), SuiteError, `missing ${missing} was accepted`);
    }
  });

  test('about is required — a suite whose purpose is unwritten cannot be judged', () => {
    assert.throws(() => validateSuite(base({ about: '' })), /about is required/);
  });

  test('duplicate case ids are refused — ids key the report', () => {
    assert.throws(() => validateSuite(base({ cases: [{ id: 'a' }, { id: 'a' }] })), /duplicate case id/);
  });

  test('an empty dataset is refused', () => {
    assert.throws(() => validateSuite(base({ cases: [] })), /non-empty/);
  });
});

// ── The three outcomes ───────────────────────────────────────────────────────

describe('eval — three outcomes, never two', () => {
  test('THE LOAD-BEARING ONE: a throw is an ERROR, not a wrong answer', async () => {
    const suite = base({
      cases: [{ id: 'ok' }, { id: 'boom' }],
      run: async c => { if (c.id === 'boom') throw new Error('kaboom'); return { status: 'ok', actual: 1 }; },
      score: () => ({ correct: true }),
      metrics: s => ({ accuracy: s.filter(x => x.correct).length / s.length }),
    });
    const { result } = await runSuite(suite);

    assert.equal(result.coverage.errored, 1);
    assert.equal(result.coverage.executed, 1);
    // The crash must NOT drag accuracy down — it was never an answer.
    assert.equal(result.metrics.accuracy, 1);
    assert.equal(result.cases.find(c => c.id === 'boom').status, 'error');
    assert.match(result.cases.find(c => c.id === 'boom').reason, /kaboom/);
  });

  test('a skipped case is never scored and never guessed', async () => {
    const suite = base({
      cases: [{ id: 'a' }, { id: 'b' }],
      run: async c => (c.id === 'b'
        ? { status: 'skipped', reason: 'no fixture' }
        : { status: 'ok', actual: 1 }),
      metrics: s => ({ n: s.length }),
    });
    const { result } = await runSuite(suite);
    assert.equal(result.coverage.skipped, 1);
    assert.equal(result.metrics.n, 1, 'a skipped case leaked into the metric');
    assert.equal(result.cases.find(c => c.id === 'b').reason, 'no fixture');
  });

  test('a skip without a reason is refused — "not executed" needs a why', async () => {
    const suite = base({ run: async () => ({ status: 'skipped' }) });
    const { result } = await runSuite(suite);
    assert.equal(result.cases[0].status, 'error');
    assert.match(result.cases[0].reason, /must carry a reason/);
  });

  test('a throwing score() is an error, not an incorrect answer', async () => {
    const suite = base({ score: () => { throw new Error('scorer bug'); } });
    const { result } = await runSuite(suite);
    assert.equal(result.cases[0].status, 'error');
    assert.match(result.cases[0].reason, /score\(\): scorer bug/);
  });

  test('score() must return a boolean correct', async () => {
    const suite = base({ score: () => ({ nearly: true }) });
    const { result } = await runSuite(suite);
    assert.equal(result.cases[0].status, 'error');
  });

  test('a throwing metrics() is reported, not crashed on', async () => {
    const suite = base({ metrics: () => { throw new Error('bad math'); } });
    const { result } = await runSuite(suite);
    assert.match(result.metricsError, /bad math/);
    assert.deepEqual(result.metrics, {});
  });

  test('a hung case times out instead of hanging the harness', async () => {
    const suite = base({ run: () => new Promise(() => {}) });
    const { result } = await runSuite(suite, { caseTimeoutMs: 60 });
    assert.equal(result.cases[0].status, 'error');
    assert.match(result.cases[0].reason, /exceeded 60ms/);
  });
});

// ── Coverage honesty ─────────────────────────────────────────────────────────

describe('eval — coverage travels with the metrics', () => {
  test('complete is false when anything did not run', async () => {
    const partial = await runSuite(base({
      cases: [{ id: 'a' }, { id: 'b' }],
      run: async c => (c.id === 'b' ? { status: 'skipped', reason: 'x' } : { status: 'ok', actual: 1 }),
    }));
    assert.equal(partial.result.coverage.complete, false);

    const full = await runSuite(base());
    assert.equal(full.result.coverage.complete, true);
  });

  test('the human view leads with coverage and shouts about a partial run', async () => {
    const { result, manifest } = await runSuite(base({
      cases: [{ id: 'a' }, { id: 'b' }],
      run: async c => (c.id === 'b' ? { status: 'skipped', reason: 'no fixture' } : { status: 'ok', actual: 1 }),
    }));
    const text = toHuman({ result, manifest });
    assert.match(text, /INCOMPLETE RUN/);
    assert.ok(text.indexOf('executed') < text.indexOf('n '), 'metrics printed before coverage');
    assert.match(text, /no fixture/);
  });

  test('metrics are empty when nothing executed — never a fabricated zero', async () => {
    const { result } = await runSuite(base({ run: async () => ({ status: 'skipped', reason: 'all out' }) }));
    assert.deepEqual(result.metrics, {});
    assert.equal(result.coverage.executed, 0);
  });
});

// ── Determinism — what the regression gate stands on ─────────────────────────

describe('eval — the comparable body does not drift', () => {
  test('two runs of the same suite produce a byte-identical result body', async () => {
    const a = await runSuite(base({ cases: [{ id: 'p' }, { id: 'q' }] }));
    const b = await runSuite(base({ cases: [{ id: 'p' }, { id: 'q' }] }));
    assert.equal(comparableBody(a), comparableBody(b));
    assert.notEqual(a.manifest.ranAt, undefined, 'the manifest still carries the clock');
  });

  test('case order in the source file does not change the report', async () => {
    const fwd = await runSuite(base({ cases: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }));
    const rev = await runSuite(base({ cases: [{ id: 'c' }, { id: 'b' }, { id: 'a' }] }));
    assert.equal(comparableBody(fwd), comparableBody(rev),
      'a dataset reordered in review must not read as a behaviour change');
  });

  test('timings are NOT in the comparable body', async () => {
    const { result } = await runSuite(base());
    assert.equal(JSON.stringify(result).includes('durationMs'), false,
      'a report that changes because the machine was busy cannot gate anything');
  });

  test('the manifest is separated from the result, and JSON keys are sorted', async () => {
    const report = await runSuite(base());
    const text = toJSON(report);
    const parsed = JSON.parse(text);
    assert.ok(parsed.manifest && parsed.result);
    // The top level keeps a fixed, readable order; determinism needs the
    // output STABLE, not alphabetised. Nested keys are sorted so a rearranged
    // object literal cannot show up as a diff.
    assert.deepEqual(Object.keys(parsed), ['schemaVersion', 'manifest', 'result']);
    assert.deepEqual(Object.keys(parsed.result), [...Object.keys(parsed.result)].sort(),
      'nested keys are not sorted — the body could drift on a refactor');
    assert.equal(text, toJSON(JSON.parse(text)), 'serialisation is not idempotent');
  });

  test('the suite fingerprint changes when the dataset changes', () => {
    const one = suiteFingerprint(base({ cases: [{ id: 'a' }] }));
    const two = suiteFingerprint(base({ cases: [{ id: 'a' }, { id: 'b' }] }));
    assert.notEqual(one, two, 'two runs over different datasets must not look comparable');
  });
});

// ── Vacuity guard on the self-test suite ─────────────────────────────────────

describe('eval — the self-test suite still exercises every path', () => {
  test('it produces exactly the outcome mix it claims', async () => {
    // Guards the guard: if the self-test suite lost its skip or its throw, the
    // harness would still pass its own suite while covering less of itself.
    const { result } = await runSuite(selftest);
    assert.equal(result.coverage.total, 5);
    assert.equal(result.coverage.executed, 3);
    assert.equal(result.coverage.skipped, 1);
    assert.equal(result.coverage.errored, 1);
    assert.equal(result.coverage.complete, false);
    assert.equal(result.metrics.correct, 2);
    assert.ok(Math.abs(result.metrics.accuracy - 2 / 3) < 1e-9);
  });

  test('it says out loud that it measures the harness, not AQUA', () => {
    assert.match(selftest.about, /not AQUA/i);
  });
});

// ── Wiring — proven, not assumed (L12) ───────────────────────────────────────

describe('eval — wiring', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

  test('the battery discovers eval/ as a default root', () => {
    // Without this, every test in this file would be invisible to `npm test` —
    // coverage that proves nothing, which is this project's oldest lesson.
    const src = readFileSync(path.join(ROOT, 'scripts/run-tests.mjs'), 'utf8');
    assert.match(src, /DEFAULT_ROOTS = \['src', 'eval'\]/);
  });

  test('package.json exposes the harness', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts.eval, 'no npm run eval');
  });

  test('the runner knows nothing about AQUA — suites plug in, the runner does not change', () => {
    // The contract E2/PR-2..PR-5 depend on. If the runner ever imports the
    // engine, adding a suite starts meaning editing the harness.
    const runner = readFileSync(path.join(ROOT, 'eval/core/runner.mjs'), 'utf8');
    for (const f of ['../src/', 'extractFacts', 'retrieveKnowledge', 'evidenceStore']) {
      assert.equal(runner.includes(f), false, `runner.mjs reaches into the engine (${f})`);
    }
  });
});
